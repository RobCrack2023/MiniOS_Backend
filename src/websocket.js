const db = require('./db/database');

// Almacenar conexiones activas
const connections = {
  devices: new Map(),    // MAC -> WebSocket
  dashboards: new Set()  // WebSockets del dashboard
};

function setupWebSocket(fastify) {

  // Endpoint para dispositivos ESP32
  fastify.get('/ws/device', { websocket: true }, (connection, req) => {
    console.log('🔌 Nueva conexión de dispositivo');

    let deviceMac = null;

    connection.socket.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleDeviceMessage(connection.socket, data, (mac) => {
          deviceMac = mac;
        });
      } catch (err) {
        console.error('Error parseando mensaje:', err);
      }
    });

    connection.socket.on('close', () => {
      if (deviceMac) {
        connections.devices.delete(deviceMac);
        // Obtener dispositivo para preservar la IP al desconectar
        const device = db.getDeviceByMac(deviceMac);
        const lastIp = device ? device.ip_address : null;
        db.updateDeviceStatus(deviceMac, false, lastIp);
        broadcastToDashboards({
          type: 'device_offline',
          mac_address: deviceMac
        });
        console.log(`📴 Dispositivo desconectado: ${deviceMac}`);
      }
    });
  });

  // Endpoint para dashboard web
  fastify.get('/ws/dashboard', { websocket: true }, (connection, req) => {
    console.log('🖥️ Nueva conexión de dashboard');

    connections.dashboards.add(connection.socket);

    // Enviar estado actual de todos los dispositivos
    const devices = db.getDevices();
    connection.socket.send(JSON.stringify({
      type: 'init',
      devices: devices
    }));

    connection.socket.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleDashboardMessage(connection.socket, data);
      } catch (err) {
        console.error('Error parseando mensaje dashboard:', err);
      }
    });

    connection.socket.on('close', () => {
      connections.dashboards.delete(connection.socket);
      console.log('🖥️ Dashboard desconectado');
    });
  });
}

// ============================================
// MANEJO DE MENSAJES DE DISPOSITIVOS
// ============================================

function handleDeviceMessage(socket, data, setMac) {
  switch (data.type) {
    case 'register':
      handleDeviceRegister(socket, data, setMac);
      break;

    case 'data':
      handleDeviceData(socket, data);
      break;

    case 'ota_status':
      handleOtaStatus(socket, data);
      break;

    case 'offline_detections':
      handleOfflineDetections(socket, data);
      break;

    default:
      console.log('Mensaje desconocido de dispositivo:', data.type);
  }
}

function handleDeviceRegister(socket, data, setMac) {
  const { firmware_version, ip_address, board_model, board_family } = data;

  // Normalizar MAC address (mayúsculas, sin espacios)
  const mac_address = data.mac_address ? data.mac_address.toUpperCase().trim() : '';

  if (!mac_address) {
    console.error('❌ Registro sin MAC address');
    return;
  }

  // Buscar o crear dispositivo
  let device = db.getDeviceByMac(mac_address);

  if (!device) {
    device = db.createDevice(mac_address);
    console.log(`✨ Nuevo dispositivo registrado: ${mac_address}`);
  }

  // Actualizar estado (incluye modelo de placa si viene del firmware)
  const updateData = {
    firmware_version,
    ip_address,
    is_online: true,
    last_seen: new Date().toISOString()
  };

  if (board_model) updateData.board_model = board_model;
  if (board_family) updateData.board_family = board_family;

  db.updateDevice(device.id, updateData);

  // Guardar conexión
  connections.devices.set(mac_address, socket);
  setMac(mac_address);

  // Obtener configuraciones
  const gpioConfigs = db.getGpioConfigs(device.id);
  const dhtConfigs = db.getDhtConfigs(device.id);
  const i2cConfigs = db.getI2cConfigs(device.id);
  const ultrasonicConfigs = db.getUltrasonicConfigs(device.id);

  // Verificar si hay OTA pendiente
  const pendingOta = db.getPendingOtaTasks(device.id);

  // Enviar configuración al dispositivo
  socket.send(JSON.stringify({
    type: 'config',
    device_id: device.id,
    gpio: gpioConfigs,
    dht: dhtConfigs,
    i2c: i2cConfigs,
    ultrasonic: ultrasonicConfigs,
    ota: pendingOta.length > 0 ? pendingOta[0] : null
  }));

  // Notificar dashboards
  broadcastToDashboards({
    type: 'device_online',
    device: db.getDeviceByMac(mac_address)
  });

  const modelInfo = board_model ? ` [${board_model}]` : '';
  console.log(`📱 Dispositivo conectado: ${mac_address} (${ip_address})${modelInfo}`);
}

function handleDeviceData(socket, data) {
  const { payload } = data;

  // Normalizar MAC address
  const mac_address = data.mac_address ? data.mac_address.toUpperCase().trim() : '';

  const device = db.getDeviceByMac(mac_address);
  if (!device) return;

  // Guardar datos de sensores DHT (nuevo formato con array)
  if (payload.dht && Array.isArray(payload.dht)) {
    console.log(`📊 Recibidos ${payload.dht.length} sensores DHT de ${mac_address}`);
    payload.dht.forEach(sensor => {
      console.log(`   DHT pin:${sensor.pin} temp:${sensor.temperature} hum:${sensor.humidity}`);
      if (sensor.temperature !== undefined) {
        db.saveSensorData(device.id, 'temperature', sensor.temperature, sensor.pin);
      }
      if (sensor.humidity !== undefined) {
        db.saveSensorData(device.id, 'humidity', sensor.humidity, sensor.pin);
      }
    });
  }

  // Guardar datos de sensores I2C (AHT20, BMP280, etc.)
  if (payload.i2c && Array.isArray(payload.i2c)) {
    console.log(`📊 Recibidos ${payload.i2c.length} sensores I2C de ${mac_address}`);
    payload.i2c.forEach(sensor => {
      console.log(`   I2C ${sensor.sensor_type} [0x${sensor.i2c_address.toString(16)}]: ${JSON.stringify({
        temp: sensor.temperature,
        hum: sensor.humidity,
        pres: sensor.pressure,
        alt: sensor.altitude
      })}`);

      if (sensor.temperature !== undefined) {
        db.saveSensorData(device.id, 'temperature', sensor.temperature, sensor.id);
      }
      if (sensor.humidity !== undefined) {
        db.saveSensorData(device.id, 'humidity', sensor.humidity, sensor.id);
      }
      if (sensor.pressure !== undefined) {
        db.saveSensorData(device.id, 'pressure', sensor.pressure, sensor.id);
      }
      if (sensor.altitude !== undefined) {
        db.saveSensorData(device.id, 'altitude', sensor.altitude, sensor.id);
      }
    });
  }

  // Compatibilidad con formato antiguo
  if (payload.temperature !== undefined) {
    db.saveSensorData(device.id, 'temperature', payload.temperature);
  }
  if (payload.humidity !== undefined) {
    db.saveSensorData(device.id, 'humidity', payload.humidity);
  }

  // Guardar datos GPIO (con soporte para analog flag)
  if (payload.gpio) {
    payload.gpio.forEach(gpio => {
      const sensorType = gpio.analog ? 'analog' : 'gpio';
      db.saveSensorData(device.id, sensorType, gpio.value, gpio.pin);
    });
  }

  // Compatibilidad con formato antiguo (array analog separado)
  if (payload.analog) {
    payload.analog.forEach(analog => {
      db.saveSensorData(device.id, 'analog', analog.value, analog.pin);
    });
  }

  // Guardar datos ultrasónicos (el análisis viene del ESP32)
  if (payload.ultrasonic && Array.isArray(payload.ultrasonic)) {
    payload.ultrasonic.forEach(sensor => {
      // Guardar lectura de distancia
      db.saveSensorData(device.id, 'distance', sensor.distance, sensor.trig_pin);

      // El análisis ya viene calculado desde el ESP32 en sensor.analysis
      // Solo notificar al dashboard si hay detección activa
      if (sensor.analysis && sensor.analysis.detected) {
        broadcastToDashboards({
          type: 'ultrasonic_detection',
          device_id: device.id,
          mac_address,
          sensor_id: sensor.id,
          detection: sensor.analysis
        });
      }
    });
  }

  // Actualizar last_seen (preservando la IP existente)
  db.updateDeviceStatus(mac_address, true, device.ip_address);

  // Preparar payload para dashboard (extraer temperatura/humedad del primer sensor DHT)
  const dashboardPayload = { ...payload };
  if (payload.dht && payload.dht.length > 0) {
    dashboardPayload.temperature = payload.dht[0].temperature;
    dashboardPayload.humidity = payload.dht[0].humidity;
  }

  // Enviar a dashboards
  broadcastToDashboards({
    type: 'device_data',
    mac_address,
    device_id: device.id,
    payload: dashboardPayload
  });
}

function handleOfflineDetections(socket, data) {
  const { mac_address, detections } = data;

  if (!mac_address || !detections || !Array.isArray(detections)) {
    console.log('Datos de detecciones offline inválidos');
    return;
  }

  const normalizedMac = mac_address.toUpperCase().trim();
  const device = db.getDeviceByMac(normalizedMac);

  if (!device) {
    console.log(`Dispositivo no encontrado para detecciones offline: ${normalizedMac}`);
    return;
  }

  console.log(`📥 Recibidas ${detections.length} detecciones offline de ${device.name}`);

  // Guardar cada detección en la base de datos
  detections.forEach((det, index) => {
    // Guardar como evento de detección
    db.saveSensorData(device.id, 'offline_detection', det.distance, null, JSON.stringify({
      animal: det.animal,
      speed: det.speed,
      duration: det.duration,
      offline_ts: det.offline_ts
    }));
  });

  // Notificar a los dashboards
  broadcastToDashboards({
    type: 'offline_detections_received',
    device_id: device.id,
    device_name: device.name,
    mac_address: normalizedMac,
    count: detections.length,
    detections: detections
  });

  console.log(`✅ Guardadas ${detections.length} detecciones offline para ${device.name}`);
}

function handleOtaStatus(socket, data) {
  const { ota_id, status, error } = data;

  // Normalizar MAC address
  const mac_address = data.mac_address ? data.mac_address.toUpperCase().trim() : '';

  db.updateOtaTask(ota_id, status, error);

  if (status === 'success') {
    const device = db.getDeviceByMac(mac_address);
    if (device) {
      // Actualizar versión del firmware
      const task = db.getPendingOtaTasks(device.id);
      // La versión se actualizará cuando el dispositivo se reconecte
    }
  }

  broadcastToDashboards({
    type: 'ota_status',
    mac_address,
    ota_id,
    status,
    error
  });
}

// ============================================
// MANEJO DE MENSAJES DEL DASHBOARD
// ============================================

function handleDashboardMessage(socket, data) {
  switch (data.type) {
    case 'command':
      sendCommandToDevice(data.mac_address, data.command);
      break;

    case 'get_device_data':
      sendDeviceHistory(socket, data.device_id);
      break;

    default:
      console.log('Mensaje desconocido de dashboard:', data.type);
  }
}

// ============================================
// FUNCIONES DE COMUNICACIÓN
// ============================================

function sendToDevice(macAddress, message) {
  const socket = connections.devices.get(macAddress);
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function sendCommandToDevice(macAddress, command) {
  return sendToDevice(macAddress, {
    type: 'command',
    ...command
  });
}

function broadcastToDashboards(message) {
  const messageStr = JSON.stringify(message);
  connections.dashboards.forEach(socket => {
    if (socket.readyState === 1) {
      socket.send(messageStr);
    }
  });
}

function broadcastToDevices(message) {
  const messageStr = JSON.stringify(message);
  connections.devices.forEach(socket => {
    if (socket.readyState === 1) {
      socket.send(messageStr);
    }
  });
}

function sendDeviceHistory(socket, deviceId) {
  const data = {
    temperature: db.getSensorData(deviceId, 'temperature', 50),
    humidity: db.getSensorData(deviceId, 'humidity', 50),
    gpio: db.getSensorData(deviceId, 'gpio', 50),
    distance: db.getSensorData(deviceId, 'distance', 100)
  };

  socket.send(JSON.stringify({
    type: 'device_history',
    device_id: deviceId,
    data
  }));
}

// Exportar para uso en rutas
module.exports = {
  setupWebSocket,
  sendToDevice,
  sendCommandToDevice,
  broadcastToDashboards,
  broadcastToDevices,
  connections
};
