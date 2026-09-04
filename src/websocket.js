const db = require('./db/database');
const { checkDeviceToken, extractDeviceToken } = require('./config');

// Almacenar conexiones activas
const connections = {
  devices: new Map(),    // MAC -> WebSocket
  dashboards: new Set()  // WebSockets del dashboard
};

// Almacenar timeouts de desconexión (para deep sleep)
// MAC -> Timer ID
const disconnectTimers = new Map();

// Tiempo de gracia antes de marcar offline (2 minutos)
const OFFLINE_GRACE_PERIOD = 2 * 60 * 1000; // 2 minutos en milisegundos

/**
 * Valida el ticket del dashboard. Devuelve el payload del usuario o null.
 * Solo acepta tokens con scope 'ws' (los emite POST /api/auth/ws-ticket),
 * nunca el JWT de sesión completo.
 */
function verifyDashboardTicket(fastify, request) {
  const token = request.query && request.query.ticket;
  if (!token) return null;

  try {
    const payload = fastify.jwt.verify(token);
    return payload && payload.scope === 'ws' ? payload : null;
  } catch (err) {
    return null;
  }
}

function setupWebSocket(fastify) {

  // Endpoint para dispositivos ESP32.
  // Si DEVICE_TOKEN está definido, el firmware debe enviarlo como ?token=... o
  // en la cabecera x-device-token. Sin él, cualquiera puede suplantar una MAC.
  fastify.get('/ws/device', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!checkDeviceToken(extractDeviceToken(request))) {
        console.warn(`🚫 Conexión de dispositivo rechazada (token inválido) desde ${request.ip}`);
        return reply.code(401).send({ error: 'Token de dispositivo inválido' });
      }
    }
  }, (connection, req) => {
    // Defensa en profundidad: si el hook no llegara a ejecutarse, cerramos aquí
    if (!checkDeviceToken(extractDeviceToken(req))) {
      connection.socket.close(1008, 'Token de dispositivo invalido');
      return;
    }

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
        // Un dispositivo que despierta de deep sleep suele registrar el socket nuevo
        // ANTES de que llegue el close del viejo. Si borrásemos sin comprobar,
        // dejaríamos fuera del mapa a una conexión viva y la marcaríamos offline.
        if (connections.devices.get(deviceMac) !== connection.socket) {
          console.log(`↩️  Cierre de una conexión antigua de ${deviceMac} (ya reconectado)`);
          return;
        }

        connections.devices.delete(deviceMac);

        // Iniciar timer de gracia para deep sleep (2 minutos)
        // Solo marcar offline si no se reconecta en ese tiempo
        console.log(`⏳ Dispositivo desconectado (esperando 2 min): ${deviceMac}`);

        const timer = setTimeout(() => {
          // Obtener dispositivo para preservar la IP al desconectar
          const device = db.getDeviceByMac(deviceMac);
          const lastIp = device ? device.ip_address : null;
          db.updateDeviceStatus(deviceMac, false, lastIp);

          // Obtener dispositivo actualizado con last_seen de la BD
          const updatedDevice = db.getDeviceByMac(deviceMac);

          broadcastToDashboards({
            type: 'device_offline',
            mac_address: deviceMac,
            last_seen: updatedDevice ? updatedDevice.last_seen : null
          });

          disconnectTimers.delete(deviceMac);
          console.log(`📴 Dispositivo marcado offline (timeout): ${deviceMac}`);
        }, OFFLINE_GRACE_PERIOD);

        disconnectTimers.set(deviceMac, timer);
      }
    });
  });

  // Endpoint para dashboard web.
  // Requiere un ticket de corta duración emitido por POST /api/auth/ws-ticket:
  // así el JWT de 24 h no viaja en la URL (ni acaba en los logs de nginx).
  fastify.get('/ws/dashboard', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!verifyDashboardTicket(fastify, request)) {
        console.warn(`🚫 Conexión de dashboard rechazada (ticket inválido) desde ${request.ip}`);
        return reply.code(401).send({ error: 'No autorizado' });
      }
    }
  }, (connection, req) => {
    // Defensa en profundidad: si el hook no llegara a ejecutarse, cerramos aquí
    const user = verifyDashboardTicket(fastify, req);
    if (!user) {
      connection.socket.close(1008, 'No autorizado');
      return;
    }

    console.log(`🖥️ Nueva conexión de dashboard (${user.username})`);

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

    case 'i2c_scan_result':
      handleI2cScanResult(socket, data);
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

  // Cancelar timer de desconexión si existe (dispositivo se reconectó antes del timeout)
  if (disconnectTimers.has(mac_address)) {
    clearTimeout(disconnectTimers.get(mac_address));
    disconnectTimers.delete(mac_address);
    console.log(`✅ Dispositivo reconectado (cancelado timeout): ${mac_address}`);
  }

  // Buscar o crear dispositivo (atómico: dos sockets con la misma MAC pueden
  // llegar a la vez y el UNIQUE de mac_address haría fallar el segundo INSERT)
  let device = db.getDeviceByMac(mac_address);
  let isNew = false;

  if (!device) {
    const created = db.getOrCreateDevice(mac_address);
    device = created.device;
    isNew = created.created;
    if (isNew) console.log(`✨ Nuevo dispositivo registrado: ${mac_address}`);
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

  // Guardar conexión, cerrando cualquier socket anterior de la misma MAC
  const previous = connections.devices.get(mac_address);
  if (previous && previous !== socket) {
    try { previous.close(1000, 'Reemplazado por una conexion nueva'); } catch (err) { /* ya cerrado */ }
  }

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
    sleep_interval: device.sleep_interval || 60000,
    gpio: gpioConfigs,
    dht: dhtConfigs,
    i2c: i2cConfigs,
    ultrasonic: ultrasonicConfigs,
    ota: pendingOta.length > 0 ? pendingOta[0] : null
  }));

  // Enviar comandos pendientes acumulados mientras estaba offline/dormido
  const pendingCmds = db.getPendingCommands(device.id);
  if (pendingCmds.length > 0) {
    console.log(`📨 Enviando ${pendingCmds.length} comando(s) pendiente(s) a ${mac_address}`);
    pendingCmds.forEach(({ command }) => {
      socket.send(JSON.stringify({ type: 'command', ...command }));
    });
    db.clearPendingCommands(device.id);
  }

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

  // Guardar datos ultrasónicos
  if (payload.ultrasonic && Array.isArray(payload.ultrasonic)) {
    payload.ultrasonic.forEach(sensor => {
      db.saveSensorData(device.id, 'distance', sensor.distance, sensor.trig_pin);
    });
  }

  // Actualizar last_seen (preservando la IP existente)
  db.updateDeviceStatus(mac_address, true, device.ip_address);

  // Obtener dispositivo actualizado con el nuevo last_seen
  const updatedDevice = db.getDeviceByMac(mac_address);

  // Preparar payload para dashboard (extraer temperatura/humedad del primer sensor DHT)
  const dashboardPayload = { ...payload };
  if (payload.dht && payload.dht.length > 0) {
    dashboardPayload.temperature = payload.dht[0].temperature;
    dashboardPayload.humidity = payload.dht[0].humidity;
  }

  // Enviar a dashboards (incluir last_seen actualizado)
  broadcastToDashboards({
    type: 'device_data',
    mac_address,
    device_id: device.id,
    last_seen: updatedDevice ? updatedDevice.last_seen : null,
    payload: dashboardPayload
  });
}


function handleI2cScanResult(socket, data) {
  const { devices } = data;

  if (!devices || !Array.isArray(devices)) {
    console.log('Datos de escaneo I2C inválidos');
    return;
  }

  console.log(`🔍 Resultado escaneo I2C: ${devices.length} dispositivo(s) encontrado(s)`);

  devices.forEach(dev => {
    console.log(`  ✓ 0x${dev.address.toString(16).toUpperCase().padStart(2, '0')} - ${dev.sensor_type}`);
  });

  // Reenviar resultados a los dashboards
  broadcastToDashboards({
    type: 'i2c_scan_result',
    devices: devices
  });
}

function handleOtaStatus(socket, data) {
  const { ota_id, status, error } = data;

  // Normalizar MAC address
  const mac_address = data.mac_address ? data.mac_address.toUpperCase().trim() : '';

  db.updateOtaTask(ota_id, status, error);

  // La versión del firmware se actualiza cuando el dispositivo se reconecta y se registra

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

// Intenta enviar un comando; si el dispositivo está offline lo encola
function sendOrQueueCommand(deviceId, macAddress, command) {
  const sent = sendCommandToDevice(macAddress, command);
  if (!sent) {
    db.savePendingCommand(deviceId, command);
    console.log(`📋 Comando encolado para dispositivo ${macAddress} (offline): ${command.action}`);
  }
  return sent;
}

function broadcastToDashboards(message) {
  const messageStr = JSON.stringify(message);
  connections.dashboards.forEach(socket => {
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
  sendOrQueueCommand,
  broadcastToDashboards,
  connections
};
