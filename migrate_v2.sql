-- Migración a v2.0.0: Soporte multi-plataforma e I2C
-- Ejecutar este script en la base de datos de producción

-- 1. Agregar columnas de modelo de placa a la tabla devices
ALTER TABLE devices ADD COLUMN board_model TEXT DEFAULT 'ESP32';
ALTER TABLE devices ADD COLUMN board_family TEXT DEFAULT 'ESP32';

-- 2. Crear tabla de configuración de sensores I2C
CREATE TABLE IF NOT EXISTS i2c_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL,
    name TEXT DEFAULT 'Sensor I2C',
    sensor_type TEXT NOT NULL,                  -- 'AHT20', 'BMP280', 'BME280'
    i2c_address INTEGER NOT NULL,               -- Dirección I2C (hex): 0x38, 0x76, 0x77, etc.
    read_interval INTEGER DEFAULT 5000,         -- Intervalo de lectura en ms
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE(device_id, i2c_address)              -- Un sensor por dirección I2C por dispositivo
);

-- 3. Crear índice para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_i2c_device ON i2c_configs(device_id);

-- 4. Verificar que todo se creó correctamente
SELECT 'Columnas agregadas a devices:' as info;
PRAGMA table_info(devices);

SELECT '' as info;
SELECT 'Tabla i2c_configs creada:' as info;
PRAGMA table_info(i2c_configs);

SELECT '' as info;
SELECT 'Índices creados:' as info;
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_i2c%';
