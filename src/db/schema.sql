-- Usuarios del dashboard
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Dispositivos ESP32
CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mac_address TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT 'Nuevo Dispositivo',
    description TEXT,
    firmware_version TEXT,
    ip_address TEXT,
    is_online INTEGER DEFAULT 0,
    last_seen DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Configuración GPIO por dispositivo
CREATE TABLE IF NOT EXISTS gpio_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    pin INTEGER NOT NULL,
    mode TEXT NOT NULL, -- OUTPUT, INPUT, INPUT_PULLUP, PWM
    name TEXT,
    value INTEGER DEFAULT 0,
    pwm_frequency INTEGER DEFAULT 5000,
    loop_enabled INTEGER DEFAULT 0,
    loop_interval INTEGER DEFAULT 1000,
    formula_enabled INTEGER DEFAULT 0,
    formula_type TEXT,
    formula_min REAL DEFAULT 0,
    formula_max REAL DEFAULT 100,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE(device_id, pin)
);

-- Configuración sensores DHT por dispositivo
CREATE TABLE IF NOT EXISTS dht_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    pin INTEGER NOT NULL,
    name TEXT,
    sensor_type TEXT DEFAULT 'DHT11', -- DHT11, DHT22
    read_interval INTEGER DEFAULT 5000,
    active INTEGER DEFAULT 1,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE(device_id, pin)
);

-- Configuración TFT por dispositivo
CREATE TABLE IF NOT EXISTS tft_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    enabled INTEGER DEFAULT 0,
    display_mode TEXT DEFAULT 'sensors',
    rotation INTEGER DEFAULT 0,
    brightness INTEGER DEFAULT 100,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE(device_id)
);

-- Datos de sensores (historial)
CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    sensor_type TEXT NOT NULL, -- temperature, humidity, gpio, analog
    sensor_pin INTEGER,
    value REAL NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

-- Firmware para OTA
CREATE TABLE IF NOT EXISTS firmware (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    filename TEXT NOT NULL,
    filesize INTEGER NOT NULL,
    checksum TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Historial de actualizaciones OTA
CREATE TABLE IF NOT EXISTS ota_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    firmware_id INTEGER NOT NULL,
    status TEXT NOT NULL, -- pending, downloading, success, failed
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    error_message TEXT,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (firmware_id) REFERENCES firmware(id) ON DELETE CASCADE
);

-- Índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_sensor_data_device ON sensor_data(device_id);
CREATE INDEX IF NOT EXISTS idx_sensor_data_recorded ON sensor_data(recorded_at);
CREATE INDEX IF NOT EXISTS idx_devices_mac ON devices(mac_address);
CREATE INDEX IF NOT EXISTS idx_ota_history_device ON ota_history(device_id);

-- Usuario admin por defecto (password: admin123)
INSERT OR IGNORE INTO users (username, password)
VALUES ('admin', '$2b$10$8K1p/a5VZ9yqRZUCK3Q6/.u7G8qXmLU1.1TQV7CvQLlq.x7xGfXJe');
