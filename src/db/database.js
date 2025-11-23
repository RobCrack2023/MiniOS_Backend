const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

let db = null;

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

  console.log('📦 Base de datos inicializada');

  // Crear usuario admin por defecto si no hay usuarios
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hashedPassword);
    console.log('👤 Usuario admin creado (admin/admin123)');
  }

  return db;
}

function getDatabase() {
  return db;
}

// ============================================
// DISPOSITIVOS
// ============================================

function getDevices() {
  return db.prepare('SELECT * FROM devices ORDER BY name').all();
}

function getDeviceByMac(macAddress) {
  return db.prepare('SELECT * FROM devices WHERE mac_address = ?').get(macAddress);
}

function getDeviceById(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

function createDevice(macAddress, name = 'Nuevo Dispositivo') {
  const stmt = db.prepare(`
    INSERT INTO devices (mac_address, name, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(macAddress, name);
  return getDeviceById(result.lastInsertRowid);
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
  if (data.is_online !== undefined) {
    fields.push('is_online = ?');
    values.push(data.is_online ? 1 : 0);
  }
  if (data.last_seen !== undefined) {
    fields.push('last_seen = ?');
    values.push(data.last_seen);
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
    SET is_online = ?, ip_address = ?, last_seen = CURRENT_TIMESTAMP
    WHERE mac_address = ?
  `);
  stmt.run(isOnline ? 1 : 0, ipAddress, macAddress);

  return getDeviceByMac(macAddress);
}

function deleteDevice(id) {
  return db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

// ============================================
// GPIO CONFIGS
// ============================================

function getGpioConfigs(deviceId) {
  return db.prepare('SELECT * FROM gpio_configs WHERE device_id = ? ORDER BY pin').all(deviceId);
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
    config.active !== false ? 1 : 0
  );
}

function deleteGpioConfig(deviceId, pin) {
  return db.prepare('DELETE FROM gpio_configs WHERE device_id = ? AND pin = ?').run(deviceId, pin);
}

// ============================================
// DHT CONFIGS
// ============================================

function getDhtConfigs(deviceId) {
  return db.prepare('SELECT * FROM dht_configs WHERE device_id = ? ORDER BY pin').all(deviceId);
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
    config.active !== false ? 1 : 0
  );
}

function deleteDhtConfig(deviceId, pin) {
  return db.prepare('DELETE FROM dht_configs WHERE device_id = ? AND pin = ?').run(deviceId, pin);
}

// ============================================
// SENSOR DATA
// ============================================

function saveSensorData(deviceId, sensorType, value, pin = null) {
  const stmt = db.prepare(`
    INSERT INTO sensor_data (device_id, sensor_type, sensor_pin, value)
    VALUES (?, ?, ?, ?)
  `);
  return stmt.run(deviceId, sensorType, pin, value);
}

function getSensorData(deviceId, sensorType = null, limit = 100) {
  if (sensorType) {
    return db.prepare(`
      SELECT * FROM sensor_data
      WHERE device_id = ? AND sensor_type = ?
      ORDER BY recorded_at DESC LIMIT ?
    `).all(deviceId, sensorType, limit);
  }
  return db.prepare(`
    SELECT * FROM sensor_data
    WHERE device_id = ?
    ORDER BY recorded_at DESC LIMIT ?
  `).all(deviceId, limit);
}

// Limpiar datos antiguos (más de 7 días)
function cleanOldSensorData(days = 7) {
  const stmt = db.prepare(`
    DELETE FROM sensor_data
    WHERE recorded_at < datetime('now', '-' || ? || ' days')
  `);
  return stmt.run(days);
}

// ============================================
// FIRMWARE / OTA
// ============================================

function getFirmwareList() {
  return db.prepare('SELECT * FROM firmware ORDER BY uploaded_at DESC').all();
}

function getFirmwareById(id) {
  return db.prepare('SELECT * FROM firmware WHERE id = ?').get(id);
}

function getActiveFirmware() {
  return db.prepare('SELECT * FROM firmware WHERE is_active = 1').get();
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

function updateOtaTask(id, status, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE ota_history
    SET status = ?, error_message = ?, completed_at = CASE WHEN ? IN ('success', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END
    WHERE id = ?
  `);
  return stmt.run(status, errorMessage, status, id);
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
  return db.prepare('SELECT * FROM ultrasonic_configs WHERE device_id = ? ORDER BY id').all(deviceId);
}

function getUltrasonicConfigById(id) {
  return db.prepare('SELECT * FROM ultrasonic_configs WHERE id = ?').get(id);
}

function setUltrasonicConfig(deviceId, config) {
  const stmt = db.prepare(`
    INSERT INTO ultrasonic_configs (
      device_id, name, trig_pin, echo_pin, max_distance, read_interval,
      detection_enabled, trigger_distance, trigger_gpio_pin, trigger_gpio_value, trigger_duration,
      smart_detection_enabled, animal_type, mouse_max_speed, mouse_max_duration, cat_min_duration, active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, trig_pin, echo_pin) DO UPDATE SET
      name = excluded.name,
      max_distance = excluded.max_distance,
      read_interval = excluded.read_interval,
      detection_enabled = excluded.detection_enabled,
      trigger_distance = excluded.trigger_distance,
      trigger_gpio_pin = excluded.trigger_gpio_pin,
      trigger_gpio_value = excluded.trigger_gpio_value,
      trigger_duration = excluded.trigger_duration,
      smart_detection_enabled = excluded.smart_detection_enabled,
      animal_type = excluded.animal_type,
      mouse_max_speed = excluded.mouse_max_speed,
      mouse_max_duration = excluded.mouse_max_duration,
      cat_min_duration = excluded.cat_min_duration,
      active = excluded.active
  `);

  return stmt.run(
    deviceId,
    config.name || 'Sensor Ultrasónico',
    config.trig_pin,
    config.echo_pin,
    config.max_distance || 400,
    config.read_interval || 100,
    config.detection_enabled !== false ? 1 : 0,
    config.trigger_distance || 50,
    config.trigger_gpio_pin || null,
    config.trigger_gpio_value !== undefined ? config.trigger_gpio_value : 1,
    config.trigger_duration || 1000,
    config.smart_detection_enabled ? 1 : 0,
    config.animal_type || 'any',
    config.mouse_max_speed || 100,
    config.mouse_max_duration || 2000,
    config.cat_min_duration || 2000,
    config.active !== false ? 1 : 0
  );
}

function deleteUltrasonicConfig(deviceId, id) {
  return db.prepare('DELETE FROM ultrasonic_configs WHERE device_id = ? AND id = ?').run(deviceId, id);
}

// ============================================
// DETECCIÓN DE ANIMALES (análisis de patrones)
// ============================================

// Buffer temporal para análisis de patrones (en memoria)
const detectionBuffers = new Map();

function addDistanceReading(deviceId, sensorId, distance) {
  const key = `${deviceId}_${sensorId}`;
  if (!detectionBuffers.has(key)) {
    detectionBuffers.set(key, {
      readings: [],
      lastDetection: null,
      detectionStart: null
    });
  }

  const buffer = detectionBuffers.get(key);
  const now = Date.now();

  // Mantener solo últimos 5 segundos de lecturas
  buffer.readings = buffer.readings.filter(r => now - r.time < 5000);
  buffer.readings.push({ distance, time: now });

  return buffer;
}

function analyzeDetection(deviceId, sensorId, config) {
  const key = `${deviceId}_${sensorId}`;
  const buffer = detectionBuffers.get(key);

  if (!buffer || buffer.readings.length < 3) {
    return { detected: false };
  }

  const readings = buffer.readings;
  const triggerDistance = config.trigger_distance;
  const now = Date.now();

  // Verificar si hay objeto dentro del rango
  const inRange = readings.filter(r => r.distance <= triggerDistance);
  if (inRange.length === 0) {
    // Objeto salió del rango
    if (buffer.detectionStart) {
      const duration = now - buffer.detectionStart;
      buffer.detectionStart = null;
      buffer.lastDetection = { endTime: now, duration };
    }
    return { detected: false };
  }

  // Objeto detectado
  if (!buffer.detectionStart) {
    buffer.detectionStart = inRange[0].time;
  }

  const duration = now - buffer.detectionStart;

  // Calcular velocidad (cambio de distancia por tiempo)
  let speed = 0;
  if (readings.length >= 2) {
    const recent = readings.slice(-5);
    let totalChange = 0;
    for (let i = 1; i < recent.length; i++) {
      totalChange += Math.abs(recent[i].distance - recent[i-1].distance);
    }
    const timeSpan = (recent[recent.length-1].time - recent[0].time) / 1000; // segundos
    speed = timeSpan > 0 ? totalChange / timeSpan : 0; // cm/s
  }

  // Clasificar animal si smart_detection está habilitado
  let animalType = 'unknown';
  if (config.smart_detection_enabled) {
    if (speed > config.mouse_max_speed || duration < config.mouse_max_duration) {
      animalType = 'mouse';
    } else if (duration >= config.cat_min_duration) {
      animalType = 'cat';
    }
  }

  return {
    detected: true,
    distance: readings[readings.length - 1].distance,
    duration,
    speed: Math.round(speed),
    animalType,
    shouldTrigger: shouldTriggerGpio(config, animalType)
  };
}

function shouldTriggerGpio(config, detectedAnimal) {
  if (!config.detection_enabled) return false;
  if (!config.trigger_gpio_pin) return false;

  if (!config.smart_detection_enabled) return true;

  const targetAnimal = config.animal_type;
  if (targetAnimal === 'any') return true;
  if (targetAnimal === 'both') return detectedAnimal === 'cat' || detectedAnimal === 'mouse';
  return targetAnimal === detectedAnimal;
}

function clearDetectionBuffer(deviceId, sensorId) {
  const key = `${deviceId}_${sensorId}`;
  detectionBuffers.delete(key);
}

module.exports = {
  initDatabase,
  getDatabase,
  // Devices
  getDevices,
  getDeviceByMac,
  getDeviceById,
  createDevice,
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
  // Sensor Data
  saveSensorData,
  getSensorData,
  cleanOldSensorData,
  // Firmware
  getFirmwareList,
  getFirmwareById,
  getActiveFirmware,
  addFirmware,
  setActiveFirmware,
  deleteFirmware,
  // OTA
  createOtaTask,
  updateOtaTask,
  getPendingOtaTasks,
  // Users
  getUserByUsername,
  createUser,
  // Ultrasonic
  getUltrasonicConfigs,
  getUltrasonicConfigById,
  setUltrasonicConfig,
  deleteUltrasonicConfig,
  // Detection Analysis
  addDistanceReading,
  analyzeDetection,
  clearDetectionBuffer
};
