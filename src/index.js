const path = require('path');

// Cargar .env ANTES de leer cualquier variable de entorno
const { loadEnvFile, resolveJwtSecret, getDeviceToken, getAllowedOrigins, getRetentionDays } = require('./config');
loadEnvFile();

const fastify = require('fastify')({ logger: true });

// Plugins
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const fastifyJwt = require('@fastify/jwt');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyMultipart = require('@fastify/multipart');

// Módulos internos
const { initDatabase, getSetting, cleanOldSensorData } = require('./db/database');
const { setupWebSocket } = require('./websocket');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const otaRoutes = require('./routes/ota');
const audioRoutes = require('./routes/audio');
const reportsRoutes = require('./routes/reports');
const { purgeOldRecordings } = require('./audioStore');

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    // Inicializar base de datos
    const db = initDatabase();
    fastify.decorate('db', db);

    // El secreto sale del entorno o de un valor aleatorio persistido en la BD
    const JWT_SECRET = resolveJwtSecret();

    if (!getDeviceToken()) {
      console.warn('⚠️  DEVICE_TOKEN no configurado: cualquiera puede conectarse a /ws/device');
      console.warn('   suplantando la MAC de un dispositivo. Defínelo en .env y en el firmware.');
    }

    // Configurar zona horaria desde la base de datos
    const timezone = getSetting('timezone') || 'America/Santiago';
    process.env.TZ = timezone;
    console.log(`🌍 Zona horaria configurada: ${timezone}`);

    // Registrar plugins
    // Sin ALLOWED_ORIGINS no se emiten cabeceras CORS: el dashboard va en el mismo
    // origen que la API, así que ninguna web externa necesita hablar con ella.
    await fastify.register(fastifyCors, {
      origin: getAllowedOrigins()
    });

    await fastify.register(fastifyJwt, {
      secret: JWT_SECRET
    });

    // 2 MB se quedaba corto: un binario de ESP32-S3 con WiFi + OTA ronda 1,3-1,8 MB.
    // throwFileSizeLimit:false hace que un archivo demasiado grande llegue marcado
    // como truncado, para poder responder 413 en vez de reventar con un 500.
    const maxFirmwareMb = Number(process.env.MAX_FIRMWARE_MB || 8);

    await fastify.register(fastifyMultipart, {
      throwFileSizeLimit: false,
      limits: {
        fileSize: maxFirmwareMb * 1024 * 1024
      }
    });

    await fastify.register(fastifyWebsocket);

    // Archivos estáticos (dashboard)
    await fastify.register(fastifyStatic, {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/'
    });

    // Decorador para verificar JWT (debe estar antes de las rutas)
    fastify.decorate('authenticate', async function(request, reply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.status(401).send({ error: 'No autorizado' });
      }
    });

    // Configurar WebSocket
    setupWebSocket(fastify);

    // Endpoint público para sincronización de tiempo (sin autenticación)
    fastify.get('/api/time', async (request, reply) => {
      const timezone = getSetting('timezone') || 'America/Santiago';
      const timestamp = Math.floor(Date.now() / 1000);
      return {
        timestamp,
        timezone,
        iso: new Date().toISOString()
      };
    });

    // Registrar rutas
    await fastify.register(authRoutes, { prefix: '/api/auth' });
    await fastify.register(apiRoutes, { prefix: '/api' });
    await fastify.register(otaRoutes, { prefix: '/api/ota' });
    await fastify.register(audioRoutes, { prefix: '/api' });
    await fastify.register(reportsRoutes, { prefix: '/api/reports' });

    // Purga periódica del historial: sin esto la tabla sensor_data crecía sin límite
    // (un HC-SR04 leyendo cada 100 ms son ~860.000 filas al día por sensor).
    const retentionDays = getRetentionDays();

    if (retentionDays > 0) {
      const purge = () => {
        try {
          const { changes } = cleanOldSensorData(retentionDays);
          if (changes > 0) console.log(`🧹 Historial purgado: ${changes} lecturas de más de ${retentionDays} días`);
        } catch (err) {
          console.error('Error purgando el historial:', err.message);
        }

        try {
          const removed = purgeOldRecordings(retentionDays);
          if (removed > 0) console.log(`🧹 Audio purgado: ${removed} grabaciones de más de ${retentionDays} días`);
        } catch (err) {
          console.error('Error purgando grabaciones:', err.message);
        }
      };

      purge();
      const purgeTimer = setInterval(purge, 24 * 60 * 60 * 1000);
      if (typeof purgeTimer.unref === 'function') purgeTimer.unref();

      console.log(`🗄️  Retención del historial: ${retentionDays} días`);
    } else {
      console.log('🗄️  Retención del historial: sin límite (no se borra nada).');
      console.log('   La tabla sensor_data crece indefinidamente: define DATA_RETENTION_DAYS');
      console.log('   en el .env (p. ej. 30) para activar la purga diaria.');
    }

    // Cierre limpio: con WAL activo conviene cerrar la BD antes de salir
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, async () => {
        console.log(`
${signal} recibido, cerrando...`);
        try { await fastify.close(); } catch (err) { /* ya cerrado */ }
        try { db.close(); } catch (err) { /* ya cerrada */ }
        process.exit(0);
      });
    }

    // Iniciar servidor
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 MiniOS Backend corriendo en http://localhost:${PORT}`);

  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
