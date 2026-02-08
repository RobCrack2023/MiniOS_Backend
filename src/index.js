const fastify = require('fastify')({ logger: true });
const path = require('path');

// Plugins
const fastifyStatic = require('@fastify/static');
const fastifyCors = require('@fastify/cors');
const fastifyJwt = require('@fastify/jwt');
const fastifyWebsocket = require('@fastify/websocket');
const fastifyMultipart = require('@fastify/multipart');

// Módulos internos
const { initDatabase } = require('./db/database');
const { setupWebSocket } = require('./websocket');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const otaRoutes = require('./routes/ota');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'minios-secret-key-change-in-production';

async function start() {
  try {
    // Inicializar base de datos
    const db = initDatabase();
    fastify.decorate('db', db);

    // Configurar zona horaria desde la base de datos
    const timezone = db.getSetting('timezone') || 'America/Santiago';
    process.env.TZ = timezone;
    console.log(`🌍 Zona horaria configurada: ${timezone}`);

    // Registrar plugins
    await fastify.register(fastifyCors, {
      origin: true
    });

    await fastify.register(fastifyJwt, {
      secret: JWT_SECRET
    });

    await fastify.register(fastifyMultipart, {
      limits: {
        fileSize: 2 * 1024 * 1024 // 2MB máximo para firmware
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

    // Registrar rutas
    await fastify.register(authRoutes, { prefix: '/api/auth' });
    await fastify.register(apiRoutes, { prefix: '/api' });
    await fastify.register(otaRoutes, { prefix: '/api/ota' });

    // Iniciar servidor
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 MiniOS Backend corriendo en http://localhost:${PORT}`);

  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
