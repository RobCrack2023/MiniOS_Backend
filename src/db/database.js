const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
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

function saveSensorData(deviceId, sensorType, value, pin = null) {
  const stmt = db.prepare(`
    INSERT INTO sensor_data (device_id, sensor_type, sensor_pin, value, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(deviceId, sensorType, pin, value, new Date().toISOString());
}

function getSensorData(deviceId, sensorType = null, limit = 100) {
  const rows = sensorType
    ? db.prepare(`
        SELECT * FROM sensor_data
        WHERE device_id = ? AND sensor_type = ?
        ORDER BY recorded_at DESC LIMIT ?
      `).all(deviceId, sensorType, limit)
    : db.prepare(`
        SELECT * FROM sensor_data
        WHERE device_id = ?
        ORDER BY recorded_at DESC LIMIT ?
      `).all(deviceId, limit);

  return rows.map(r => ({ ...r, recorded_at: toUtcIso(r.recorded_at) }));
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
  const list = db.prepare('SELECT * FROM firmware ORDER BY uploaded_at DESC').all();
  return list.map(fw => ({ ...fw, is_active: Boolean(fw.is_active) }));
}

function getFirmwareById(id) {
  const fw = db.prepare('SELECT * FROM firmware WHERE id = ?').get(id);
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
  const configs = db.prepare('SELECT * FROM ultrasonic_configs WHERE device_id = ? ORDER BY id').all(deviceId);
  return configs.map(config => ({
    ...config,
    detection_enabled: Boolean(config.detection_enabled),
    active: Boolean(config.active)
  }));
}

function getUltrasonicConfigById(id) {
  return db.prepare('SELECT * FROM ultrasonic_configs WHERE id = ?').get(id);
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
    config.trigger_gpio_pin || null,
    config.trigger_gpio_value !== undefined ? config.trigger_gpio_value : 1,
    config.trigger_duration || 1000,
    config.active === false ? 0 : 1
  );
}

function deleteUltrasonicConfig(deviceId, id) {
  return db.prepare('DELETE FROM ultrasonic_configs WHERE device_id = ? AND id = ?').run(deviceId, id);
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
  return db.prepare('SELECT key, value FROM system_settings').all();
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
  // I2C
  getI2cConfigs,
  setI2cConfig,
  deleteI2cConfig,
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
  // Pending Commands
  savePendingCommand,
  getPendingCommands,
  clearPendingCommands,
  // System Settings
  getSetting,
  setSetting,
  getAllSettings
};
