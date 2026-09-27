const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let db = null;

// Normaliza timestamps de SQLite (sin timezone) a ISO 8601 UTC con 'Z'
// 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SSZ'
// Ya correctos ('...Z' o '...+HH:MM') se devuelven sin cambios
function toUtcIso(ts) {
  if (!ts) return ts;
  if (ts.includes('Z') || ts.includes('+')) return ts;
  return ts.replace(' ', 'T') + 'Z';
}

function initDatabase() {
  const dbPath = path.join(__dirname, '..', '..', 'minios.db');
  db = new Database(dbPath);

  // Habilitar foreign keys
  db.pragma('foreign_keys = ON');

  // Habilitar modo WAL para mejor rendimiento en concurrencia
  db.pragma('journal_mode = WAL');

  // Ejecutar schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  // Migraciones: añadir columnas nuevas si no existen.
  // Las tablas nuevas las crea schema.sql con IF NOT EXISTS, pero las columnas
  // añadidas a tablas existentes hay que migrarlas a mano (una BD anterior a la
  // v2 no tenía board_model ni board_family y las consultas fallaban).
  const deviceCols = db.prepare("PRAGMA table_info(devices)").all().map(c => c.name);

  const deviceMigrations = [
    ['sleep_interval', 'INTEGER DEFAULT 60000'],
    ['board_model', "TEXT DEFAULT 'ESP32'"],
    ['board_family', "TEXT DEFAULT 'ESP32'"]
  ];

  for (const [column, definition] of deviceMigrations) {
    if (!deviceCols.includes(column)) {
      db.exec(`ALTER TABLE devices ADD COLUMN ${column} ${definition}`);
      console.log(`🔧 Migración: columna ${column} añadida a devices`);
    }
  }

  // sensor_pin guarda el pin en un DHT pero el id de config en un I2C: sin el
  // origen, un DHT en el pin 4 y un I2C con id 4 se mezclaban en la misma serie
  const sensorDataCols = db.prepare("PRAGMA table_info(sensor_data)").all().map(c => c.name);
  if (!sensorDataCols.includes('source')) {
    db.exec('ALTER TABLE sensor_data ADD COLUMN source TEXT');
    console.log('🔧 Migración: columna source añadida a sensor_data');
  }

  console.log('📦 Base de datos inicializada');

  // Crear usuario admin si no hay usuarios.
  // La contraseña es aleatoria y se muestra una sola vez: nunca se despliega
  // una instalación con credenciales conocidas.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const generated = crypto.randomBytes(12).toString('base64url');
    const hashedPassword = bcrypt.hashSync(generated, 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hashedPassword);
    console.log('');
    console.log('👤 Usuario admin creado.');
    console.log(`   Usuario:    admin`);
    console.log(`   Contraseña: ${generated}`);
    console.log('   ⚠️  Anótala ahora: no se volverá a mostrar. Cámbiala desde Configuración.');
    console.log('');
  } else {
    // Avisar si una instalación antigua sigue con la contraseña por defecto
    const admin = db.prepare('SELECT password FROM users WHERE username = ?').get('admin');
    if (admin && bcrypt.compareSync('admin123', admin.password)) {
      console.warn('');
      console.warn('🚨 El usuario admin todavía usa la contraseña por defecto "admin123".');
      console.warn('   Cámbiala YA en el dashboard: Configuración → Cambiar contraseña.');
      console.warn('');
    }
  }

  return db;
}

function getDatabase() {
  return db;
}

// ============================================
// DISPOSITIVOS
// ============================================

function normalizeDevice(device) {
  return {
    ...device,
    is_online: Boolean(device.is_online),
    last_seen: toUtcIso(device.last_seen),
    created_at: toUtcIso(device.created_at)
  };
}

function getDevices() {
  const devices = db.prepare('SELECT * FROM devices ORDER BY name').all();
  return devices.map(normalizeDevice);
}

function getDeviceByMac(macAddress) {
  const device = db.prepare('SELECT * FROM devices WHERE mac_address = ?').get(macAddress);
  if (!device) return null;
  return normalizeDevice(device);
}

function getDeviceById(id) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) return null;
  return normalizeDevice(device);
}

function createDevice(macAddress, name = 'Nuevo Dispositivo') {
  const stmt = db.prepare(`
    INSERT INTO devices (mac_address, name, created_at)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(macAddress, name, new Date().toISOString());
  return getDeviceById(result.lastInsertRowid);
}

/**
 * Devuelve el dispositivo de esa MAC, creándolo si no existe.
 * Atómico: si dos conexiones con la misma MAC llegan a la vez, una crea la fila y
 * la otra recupera la existente en lugar de reventar contra UNIQUE(mac_address).
 */
function getOrCreateDevice(macAddress, name = 'Nuevo Dispositivo') {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO devices (mac_address, name, created_at)
    VALUES (?, ?, ?)
  `);

  const result = insert.run(macAddress, name, new Date().toISOString());

  return {
    device: getDeviceByMac(macAddress),
    created: result.changes > 0
  };
}

function updateDevice(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push('description = ?');
    values.push(data.description);
  }
  if (data.firmware_version !== undefined) {
    fields.push('firmware_version = ?');
    values.push(data.firmware_version);
  }
  if (data.ip_address !== undefined) {
    fields.push('ip_address = ?');
    values.push(data.ip_address);
  }
  if (data.board_model !== undefined) {
    fields.push('board_model = ?');
    values.push(data.board_model);
  }
  if (data.board_family !== undefined) {
    fields.push('board_family = ?');
    values.push(data.board_family);
  }
  if (data.is_online !== undefined) {
    fields.push('is_online = ?');
    values.push(data.is_online ? 1 : 0);
  }
  if (data.last_seen !== undefined) {
    fields.push('last_seen = ?');
    values.push(data.last_seen);
  }
  if (data.sleep_interval !== undefined) {
    fields.push('sleep_interval = ?');
    values.push(data.sleep_interval);
  }

  if (fields.length === 0) return getDeviceById(id);

  values.push(id);
  const sql = `UPDATE devices SET ${fields.join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...values);

  return getDeviceById(id);
}

function updateDeviceStatus(macAddress, isOnline, ipAddress = null) {
  const device = getDeviceByMac(macAddress);
  if (!device) return null;

  const stmt = db.prepare(`
    UPDATE devices
    SET is_online = ?, ip_address = ?, last_seen = ?
    WHERE mac_address = ?
  `);
  stmt.run(isOnline ? 1 : 0, ipAddress, new Date().toISOString(), macAddress);

  return getDeviceByMac(macAddress);
}

function deleteDevice(id) {
  return db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

// ============================================
// GPIO CONFIGS
// ============================================

function getGpioConfigs(deviceId) {
  const configs = db.prepare('SELECT * FROM gpio_configs WHERE device_id = ? ORDER BY pin').all(deviceId);
  // Convertir 0/1 de SQLite a booleanos para el frontend
  return configs.map(config => ({
    ...config,
    loop_enabled: Boolean(config.loop_enabled),
    formula_enabled: Boolean(config.formula_enabled),
    active: Boolean(config.active)
  }));
}

function setGpioConfig(deviceId, config) {
  const stmt = db.prepare(`
    INSERT INTO gpio_configs (device_id, pin, mode, name, value, pwm_frequency, loop_enabled, loop_interval, formula_enabled, formula_type, formula_min, formula_max, unit, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, pin) DO UPDATE SET
      mode = excluded.mode,
      name = excluded.name,
      value = excluded.value,
      pwm_frequency = excluded.pwm_frequency,
      loop_enabled = excluded.loop_enabled,
      loop_interval = excluded.loop_interval,
      formula_enabled = excluded.formula_enabled,
      formula_type = excluded.formula_type,
      formula_min = excluded.formula_min,
      formula_max = excluded.formula_max,
      unit = excluded.unit,
      active = excluded.active
  `);

  return stmt.run(
    deviceId,
    config.pin,
    config.mode || 'OUTPUT',
    config.name || `GPIO ${config.pin}`,
    config.value || 0,
    config.pwm_frequency || 5000,
    config.loop_enabled ? 1 : 0,
    config.loop_interval || 1000,
    config.formula_enabled ? 1 : 0,
    config.formula_type || null,
    config.formula_min || 0,
    config.formula_max || 100,
    config.unit || '',
    config.active === false ? 0 : 1
  );
}

function deleteGpioConfig(deviceId, pin) {
  return db.prepare('DELETE FROM gpio_configs WHERE device_id = ? AND pin = ?').run(deviceId, pin);
}

// ============================================
// DHT CONFIGS
// ============================================

function getDhtConfigs(deviceId) {
  const configs = db.prepare('SELECT * FROM dht_configs WHERE device_id = ? ORDER BY pin').all(deviceId);
  // Convertir 0/1 de SQLite a booleanos para el frontend
  return configs.map(config => ({
    ...config,
    active: Boolean(config.active)
  }));
}

function setDhtConfig(deviceId, config) {
  const stmt = db.prepare(`
    INSERT INTO dht_configs (device_id, pin, name, sensor_type, read_interval, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, pin) DO UPDATE SET
      name = excluded.name,
      sensor_type = excluded.sensor_type,
      read_interval = excluded.read_interval,
      active = excluded.active
  `);

  return stmt.run(
    deviceId,
    config.pin,
    config.name || `DHT ${config.pin}`,
    config.sensor_type || 'DHT11',
    config.read_interval || 5000,
    config.active === false ? 0 : 1
  );
}

function deleteDhtConfig(deviceId, pin) {
  return db.prepare('DELETE FROM dht_configs WHERE device_id = ? AND pin = ?').run(deviceId, pin);
}

// ============================================
// I2C CONFIGS
// ============================================

function getI2cConfigs(deviceId) {
  const configs = db.prepare('SELECT * FROM i2c_configs WHERE device_id = ? ORDER BY id').all(deviceId);
  // Convertir 0/1 de SQLite a booleanos para el frontend
  return configs.map(config => ({
    ...config,
    active: Boolean(config.active)
  }));
}

function setI2cConfig(deviceId, config) {
  const stmt = db.prepare(`
    INSERT INTO i2c_configs (device_id, name, sensor_type, i2c_address, read_interval, active)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, i2c_address) DO UPDATE SET
      name = excluded.name,
      sensor_type = excluded.sensor_type,
      read_interval = excluded.read_interval,
      active = excluded.active
  `);

  return stmt.run(
    deviceId,
    config.name || `Sensor I2C 0x${config.i2c_address.toString(16).toUpperCase()}`,
    config.sensor_type,
    config.i2c_address,
    config.read_interval || 5000,
    config.active === false ? 0 : 1
  );
}

function deleteI2cConfig(deviceId, i2cAddress) {
  return db.prepare('DELETE FROM i2c_configs WHERE device_id = ? AND i2c_address = ?').run(deviceId, i2cAddress);
}

// ============================================
// SENSOR DATA
// ============================================

function saveSensorData(deviceId, sensorType, value, pin = null, source = null) {
  const stmt = db.prepare(`
    INSERT INTO sensor_data (device_id, sensor_type, sensor_pin, source, value, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(deviceId, sensorType, pin, source, value, new Date().toISOString());
}

const MAX_SENSOR_ROWS = 50000;

function getSensorData(deviceId, sensorType = null, limit = 100, fromDate = null, toDate = null) {
  // Antes, cualquier consulta con rango de fechas ignoraba el limit y devolvía
  // 10.000 filas en silencio: el gráfico parecía completo sin serlo.
  const parsed = Number.parseInt(limit, 10);
  const effectiveLimit = Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_SENSOR_ROWS)
    : 100;

  const conditions = ['device_id = ?'];
  const params = [deviceId];

  if (sensorType) { conditions.push('sensor_type = ?'); params.push(sensorType); }
  if (fromDate)   { conditions.push('recorded_at >= ?'); params.push(fromDate); }
  if (toDate)     { conditions.push('recorded_at <= ?'); params.push(toDate); }

  const sql = `SELECT * FROM sensor_data WHERE ${conditions.join(' AND ')} ORDER BY recorded_at DESC LIMIT ?`;
  params.push(effectiveLimit);

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({ ...r, recorded_at: toUtcIso(r.recorded_at) }));
}

/** Total de filas que cumplen el filtro, para detectar resultados truncados. */
function countSensorData(deviceId, sensorType = null, fromDate = null, toDate = null) {
  const conditions = ['device_id = ?'];
  const params = [deviceId];

  if (sensorType) { conditions.push('sensor_type = ?'); params.push(sensorType); }
  if (fromDate)   { conditions.push('recorded_at >= ?'); params.push(fromDate); }
  if (toDate)     { conditions.push('recorded_at <= ?'); params.push(toDate); }

  const row = db.prepare(
    `SELECT COUNT(*) as total FROM sensor_data WHERE ${conditions.join(' AND ')}`
  ).get(...params);

  return row.total;
}

// ============================================
// REPORTES (datos agregados)
// ============================================

/**
 * Lecturas agregadas por intervalos de `bucketSeconds` entre `from` y `to`
 * (ISO 8601). Una fila por serie (tipo + origen + pin) e intervalo. Así un
 * gráfico de 30 días recibe unos cientos de puntos en vez de 50.000 filas, y
 * todas las series comparten los mismos instantes en el eje X.
 */
function getSensorAggregates(deviceId, from, to, bucketSeconds) {
  return db.prepare(`
    SELECT sensor_type, source, sensor_pin,
           (CAST(strftime('%s', recorded_at) AS INTEGER) / ?) * ? AS bucket,
           AVG(value) AS avg, MIN(value) AS min, MAX(value) AS max, COUNT(*) AS n
    FROM sensor_data
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
    GROUP BY sensor_type, source, sensor_pin, bucket
    ORDER BY bucket
  `).all(bucketSeconds, bucketSeconds, deviceId, from, to);
}

/** Mínimo, máximo, promedio y número de lecturas de cada serie en el rango. */
function getSensorSummary(deviceId, from, to) {
  return db.prepare(`
    SELECT sensor_type, source, sensor_pin,
           MIN(value) AS min, MAX(value) AS max, AVG(value) AS avg, COUNT(*) AS count
    FROM sensor_data
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
    GROUP BY sensor_type, source, sensor_pin
  `).all(deviceId, from, to);
}

/**
 * Última lectura de cada serie en el rango. SQLite devuelve las columnas sueltas
 * (value) de la fila que da el MAX() cuando es el único agregado de la consulta.
 */
function getSensorLast(deviceId, from, to) {
  return db.prepare(`
    SELECT sensor_type, source, sensor_pin, value, MAX(recorded_at) AS recorded_at
    FROM sensor_data
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
    GROUP BY sensor_type, source, sensor_pin
  `).all(deviceId, from, to).map(r => ({ ...r, recorded_at: toUtcIso(r.recorded_at) }));
}

/** Lecturas crudas del rango para exportar, de la más antigua a la más reciente. */
function getSensorRows(deviceId, from, to, limit) {
  return db.prepare(`
    SELECT sensor_type, source, sensor_pin, value, recorded_at
    FROM sensor_data
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
    ORDER BY recorded_at ASC
    LIMIT ?
  `).all(deviceId, from, to, limit).map(r => ({ ...r, recorded_at: toUtcIso(r.recorded_at) }));
}

/** Grabaciones del rango, de la más reciente a la más antigua. */
function getAudioRecordingsInRange(deviceId, from, to, limit) {
  return db.prepare(`
    SELECT * FROM audio_recordings
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT ?
  `).all(deviceId, from, to, limit).map(normalizeRecording);
}

function getAudioSummary(deviceId, from, to) {
  return db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
           COALESCE(SUM(size_bytes), 0) AS total_bytes,
           AVG(rms_dbfs) AS avg_rms_dbfs,
           MAX(peak_dbfs) AS max_peak_dbfs
    FROM audio_recordings
    WHERE device_id = ? AND recorded_at >= ? AND recorded_at <= ?
  `).get(deviceId, from, to);
}

/**
 * Borra el historial más antiguo que `days`.
 * El corte se calcula en JS porque recorded_at se guarda en ISO 8601 con 'T' y 'Z',
 * y datetime('now') devuelve 'YYYY-MM-DD HH:MM:SS': comparar ambos formatos como
 * texto es frágil.
 */
function cleanOldSensorData(days = 30) {
  if (!Number.isInteger(days) || days <= 0) return { changes: 0 };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare('DELETE FROM sensor_data WHERE recorded_at < ?').run(cutoff);
}

// ============================================
// FIRMWARE / OTA
// ============================================

function getFirmwareList() {
  const list = db.prepare('SELECT * FROM firmware ORDER BY uploaded_at DESC').all();
  return list.map(fw => ({ ...fw, is_active: Boolean(fw.is_active) }));
}

function getFirmwareById(id) {
  const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(id);
  if (!fw) return null;
  return { ...fw, is_active: Boolean(fw.is_active) };
}

function getFirmwareByFilename(filename) {
  const fw = db.prepare('SELECT * FROM firmware WHERE filename = ?').get(filename);
  if (!fw) return null;
  return { ...fw, is_active: Boolean(fw.is_active) };
}

function getActiveFirmware() {
  const fw = db.prepare('SELECT * FROM firmware WHERE is_active = 1').get();
  if (!fw) return null;
  return { ...fw, is_active: Boolean(fw.is_active) };
}

function addFirmware(version, filename, filesize, checksum, description = '') {
  const stmt = db.prepare(`
    INSERT INTO firmware (version, filename, filesize, checksum, description)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(version, filename, filesize, checksum, description);
  return getFirmwareById(result.lastInsertRowid);
}

function setActiveFirmware(id) {
  db.prepare('UPDATE firmware SET is_active = 0').run();
  db.prepare('UPDATE firmware SET is_active = 1 WHERE id = ?').run(id);
  return getFirmwareById(id);
}

function deleteFirmware(id) {
  return db.prepare('DELETE FROM firmware WHERE id = ?').run(id);
}

// ============================================
// OTA HISTORY
// ============================================

function createOtaTask(deviceId, firmwareId) {
  const stmt = db.prepare(`
    INSERT INTO ota_history (device_id, firmware_id, status)
    VALUES (?, ?, 'pending')
  `);
  return stmt.run(deviceId, firmwareId);
}

const OTA_STATUSES = ['pending', 'downloading', 'success', 'failed'];

function isValidOtaStatus(status) {
  return OTA_STATUSES.includes(status);
}

function updateOtaTask(id, status, errorMessage = null) {
  if (!isValidOtaStatus(status)) {
    throw new Error(`Estado OTA inválido: ${status}`);
  }

  const otaId = Number.parseInt(id, 10);
  if (!Number.isInteger(otaId)) return { changes: 0 };

  const stmt = db.prepare(`
    UPDATE ota_history
    SET status = ?, error_message = ?, completed_at = CASE WHEN ? IN ('success', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `);
  return stmt.run(status, errorMessage == null ? null : String(errorMessage), status, otaId);
}

function getPendingOtaTasks(deviceId) {
  return db.prepare(`
    SELECT oh.*, f.filename, f.version, f.checksum, f.filesize
    FROM ota_history oh
    JOIN firmware f ON oh.firmware_id = f.id
    WHERE oh.device_id = ? AND oh.status = 'pending'
    ORDER BY oh.started_at ASC
  `).all(deviceId);
}

// ============================================
// USERS
// ============================================

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser(username, hashedPassword) {
  const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  return stmt.run(username, hashedPassword);
}

// ============================================
// ULTRASONIC CONFIGS
// ============================================

function getUltrasonicConfigs(deviceId) {
  const configs = db.prepare('SELECT * FROM ultrasonic_configs WHERE device_id = ? ORDER BY id').all(deviceId);
  return configs.map(config => ({
    ...config,
    detection_enabled: Boolean(config.detection_enabled),
    active: Boolean(config.active)
  }));
}

function setUltrasonicConfig(deviceId, config) {
  const stmt = db.prepare(`
    INSERT INTO ultrasonic_configs (
      device_id, name, trig_pin, echo_pin, max_distance, read_interval,
      detection_enabled, trigger_distance, trigger_gpio_pin, trigger_gpio_value, trigger_duration,
      active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, trig_pin, echo_pin) DO UPDATE SET
      name = excluded.name,
      max_distance = excluded.max_distance,
      read_interval = excluded.read_interval,
      detection_enabled = excluded.detection_enabled,
      trigger_distance = excluded.trigger_distance,
      trigger_gpio_pin = excluded.trigger_gpio_pin,
      trigger_gpio_value = excluded.trigger_gpio_value,
      trigger_duration = excluded.trigger_duration,
      active = excluded.active
  `);

  return stmt.run(
    deviceId,
    config.name || 'Sensor Ultrasónico',
    config.trig_pin,
    config.echo_pin,
    config.max_distance || 400,
    config.read_interval || 100,
    config.detection_enabled === false ? 0 : 1,
    config.trigger_distance || 50,
    config.trigger_gpio_pin === undefined || config.trigger_gpio_pin === null || config.trigger_gpio_pin === ''
      ? null
      : Number(config.trigger_gpio_pin),   // el GPIO 0 es válido: no usar '||'
    config.trigger_gpio_value !== undefined ? config.trigger_gpio_value : 1,
    config.trigger_duration || 1000,
    config.active === false ? 0 : 1
  );
}

function deleteUltrasonicConfig(deviceId, id) {
  return db.prepare('DELETE FROM ultrasonic_configs WHERE device_id = ? AND id = ?').run(deviceId, id);
}


// ============================================
// AUDIO (micrófono I2S)
// ============================================

function normalizeAudioConfig(config) {
  return config ? { ...config, enabled: Boolean(config.enabled) } : null;
}

function getAudioConfig(deviceId) {
  return normalizeAudioConfig(
    db.prepare('SELECT * FROM audio_configs WHERE device_id = ?').get(deviceId)
  );
}

function setAudioConfig(deviceId, config) {
  db.prepare(`
    INSERT INTO audio_configs (
      device_id, enabled, sck_pin, ws_pin, sd_pin, channel,
      sample_rate, duration_sec, capture_interval_sec, gain
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      enabled = excluded.enabled,
      sck_pin = excluded.sck_pin,
      ws_pin = excluded.ws_pin,
      sd_pin = excluded.sd_pin,
      channel = excluded.channel,
      sample_rate = excluded.sample_rate,
      duration_sec = excluded.duration_sec,
      capture_interval_sec = excluded.capture_interval_sec,
      gain = excluded.gain
  `).run(
    deviceId,
    config.enabled ? 1 : 0,
    config.sck_pin,
    config.ws_pin,
    config.sd_pin,
    config.channel ?? 0,
    config.sample_rate ?? 16000,
    config.duration_sec ?? 10,
    config.capture_interval_sec ?? 300,   // 0 es válido (en cada ciclo): no usar '||'
    config.gain ?? 16
  );

  return getAudioConfig(deviceId);
}

function normalizeRecording(rec) {
  return rec ? { ...rec, recorded_at: toUtcIso(rec.recorded_at) } : null;
}

function addAudioRecording(deviceId, rec) {
  const result = db.prepare(`
    INSERT INTO audio_recordings (device_id, filename, sample_rate, duration_ms, size_bytes, rms_dbfs, peak_dbfs, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deviceId, rec.filename, rec.sample_rate, rec.duration_ms, rec.size_bytes,
    rec.rms_dbfs, rec.peak_dbfs, new Date().toISOString()
  );

  return getAudioRecordingById(result.lastInsertRowid);
}

function getAudioRecordings(deviceId, limit = 50) {
  return db.prepare(
    'SELECT * FROM audio_recordings WHERE device_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?'
  ).all(deviceId, limit).map(normalizeRecording);
}

function countAudioRecordings(deviceId) {
  return db.prepare('SELECT COUNT(*) as total FROM audio_recordings WHERE device_id = ?').get(deviceId).total;
}

function getAudioRecordingById(id) {
  return normalizeRecording(db.prepare('SELECT * FROM audio_recordings WHERE id = ?').get(id));
}

function deleteAudioRecording(id) {
  return db.prepare('DELETE FROM audio_recordings WHERE id = ?').run(id);
}

/** Grabaciones que sobran por encima de las `keep` más recientes de un dispositivo. */
function getExcessAudioRecordings(deviceId, keep) {
  return db.prepare(`
    SELECT * FROM audio_recordings WHERE device_id = ?
    ORDER BY recorded_at DESC, id DESC LIMIT -1 OFFSET ?
  `).all(deviceId, keep);
}

/** Grabaciones más antiguas que `days` (mismo criterio que cleanOldSensorData). */
function getOldAudioRecordings(days) {
  if (!Number.isInteger(days) || days <= 0) return [];
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare('SELECT * FROM audio_recordings WHERE recorded_at < ?').all(cutoff);
}

function getAudioRecordingFilenames(deviceId) {
  return db.prepare('SELECT filename FROM audio_recordings WHERE device_id = ?')
    .all(deviceId)
    .map(r => r.filename);
}

// ============================================
// COMANDOS PENDIENTES
// ============================================

function savePendingCommand(deviceId, command) {
  return db.prepare('INSERT INTO pending_commands (device_id, command) VALUES (?, ?)')
    .run(deviceId, JSON.stringify(command));
}

function getPendingCommands(deviceId) {
  return db.prepare('SELECT id, command FROM pending_commands WHERE device_id = ? ORDER BY created_at ASC')
    .all(deviceId)
    .map(r => ({ id: r.id, command: JSON.parse(r.command) }));
}

function clearPendingCommands(deviceId) {
  return db.prepare('DELETE FROM pending_commands WHERE device_id = ?').run(deviceId);
}

// ============================================
// CONFIGURACIÓN DEL SISTEMA
// ============================================

function getSetting(key) {
  const setting = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return setting ? setting.value : null;
}

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(key, value, value);
  return { key, value };
}

function getAllSettings() {
  // Las claves con prefijo '_' son internas (p. ej. _jwt_secret) y no se exponen
  return db.prepare("SELECT key, value FROM system_settings WHERE substr(key, 1, 1) <> '_'").all();
}

module.exports = {
  initDatabase,
  getDatabase,
  // Devices
  getDevices,
  getDeviceByMac,
  getDeviceById,
  createDevice,
  getOrCreateDevice,
  updateDevice,
  updateDeviceStatus,
  deleteDevice,
  // GPIO
  getGpioConfigs,
  setGpioConfig,
  deleteGpioConfig,
  // DHT
  getDhtConfigs,
  setDhtConfig,
  deleteDhtConfig,
  // I2C
  getI2cConfigs,
  setI2cConfig,
  deleteI2cConfig,
  // Sensor Data
  saveSensorData,
  getSensorData,
  countSensorData,
  cleanOldSensorData,
  // Reportes
  getSensorAggregates,
  getSensorSummary,
  getSensorLast,
  getSensorRows,
  getAudioRecordingsInRange,
  getAudioSummary,
  // Firmware
  getFirmwareList,
  getFirmwareById,
  getFirmwareByFilename,
  getActiveFirmware,
  addFirmware,
  setActiveFirmware,
  deleteFirmware,
  // OTA
  createOtaTask,
  updateOtaTask,
  isValidOtaStatus,
  getPendingOtaTasks,
  // Users
  getUserByUsername,
  createUser,
  // Ultrasonic
  getUltrasonicConfigs,
  setUltrasonicConfig,
  deleteUltrasonicConfig,
  // Audio
  getAudioConfig,
  setAudioConfig,
  addAudioRecording,
  getAudioRecordings,
  countAudioRecordings,
  getAudioRecordingById,
  deleteAudioRecording,
  getExcessAudioRecordings,
  getOldAudioRecordings,
  getAudioRecordingFilenames,
  // Pending Commands
  savePendingCommand,
  getPendingCommands,
  clearPendingCommands,
  // System Settings
  getSetting,
  setSetting,
  getAllSettings
};
