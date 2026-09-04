const bcrypt = require('bcrypt');
const db = require('../db/database');
const rateLimit = require('../rateLimit');

async function authRoutes(fastify, options) {

  // Login
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 256 }
        }
      }
    }
  }, async (request, reply) => {
    const { username, password } = request.body;

    // Freno de fuerza bruta: por IP y por usuario
    const keys = rateLimit.loginKeys(request.ip, username);
    const wait = rateLimit.retryAfter(keys);

    if (wait > 0) {
      return reply
        .status(429)
        .header('Retry-After', String(wait))
        .send({ error: `Demasiados intentos fallidos. Reintenta en ${wait} segundos.` });
    }

    const user = db.getUserByUsername(username);

    if (!user) {
      rateLimit.registerFailure(keys);
      return reply.status(401).send({ error: 'Credenciales inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      rateLimit.registerFailure(keys);
      return reply.status(401).send({ error: 'Credenciales inválidas' });
    }

    rateLimit.registerSuccess(keys);

    const token = fastify.jwt.sign({
      id: user.id,
      username: user.username
    }, { expiresIn: '24h' });

    return {
      token,
      user: {
        id: user.id,
        username: user.username
      }
    };
  });

  // Verificar token
  fastify.get('/verify', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    return {
      valid: true,
      user: request.user
    };
  });

  // Ticket de corta duración para abrir el WebSocket del dashboard.
  // El navegador no puede enviar cabeceras al abrir un WebSocket, así que en vez
  // de poner el JWT de 24 h en la URL se emite este ticket de un minuto.
  fastify.post('/ws-ticket', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const ticket = fastify.jwt.sign({
      id: request.user.id,
      username: request.user.username,
      scope: 'ws'
    }, { expiresIn: '60s' });

    return { ticket };
  });

  // Cambiar contraseña
  fastify.post('/change-password', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body;

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'Contraseñas requeridas' });
    }

    if (newPassword.length < 6) {
      return reply.status(400).send({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const user = db.getUserByUsername(request.user.username);
    const validPassword = await bcrypt.compare(currentPassword, user.password);

    if (!validPassword) {
      return reply.status(401).send({ error: 'Contraseña actual incorrecta' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const stmt = fastify.db.prepare('UPDATE users SET password = ? WHERE id = ?');
    stmt.run(hashedPassword, user.id);

    return { success: true, message: 'Contraseña actualizada' };
  });

  // Crear usuario inicial (solo si no existe ninguno)
  fastify.post('/setup', async (request, reply) => {
    const { username, password } = request.body;

    // Verificar si ya hay usuarios
    const users = fastify.db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (users.count > 0) {
      return reply.status(400).send({ error: 'Ya existe un usuario configurado' });
    }

    if (!username || !password || password.length < 6) {
      return reply.status(400).send({ error: 'Usuario y contraseña (min 6 caracteres) requeridos' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    db.createUser(username, hashedPassword);

    return { success: true, message: 'Usuario creado correctamente' };
  });
}

module.exports = authRoutes;
