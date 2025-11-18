const bcrypt = require('bcrypt');
const db = require('../db/database');

async function authRoutes(fastify, options) {

  // Login
  fastify.post('/login', async (request, reply) => {
    const { username, password } = request.body;

    if (!username || !password) {
      return reply.status(400).send({ error: 'Usuario y contraseña requeridos' });
    }

    const user = db.getUserByUsername(username);

    if (!user) {
      return reply.status(401).send({ error: 'Credenciales inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return reply.status(401).send({ error: 'Credenciales inválidas' });
    }

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
