/**
 * Limitador de intentos en memoria, sin dependencias.
 * Pensado para una sola instancia (el despliegue con PM2 usa un proceso).
 * Si algún día se escala a varios procesos, esto hay que moverlo a la BD o a Redis.
 */

const WINDOW_MS = 15 * 60 * 1000;   // ventana de conteo
const BLOCK_MS = 15 * 60 * 1000;    // bloqueo tras superar el límite

// Límites por clave: más estricto por usuario, más holgado por IP
const LIMITS = {
  user: 10,
  ip: 30
};

const buckets = new Map(); // clave -> { count, expiresAt, blockedUntil }

function getBucket(key) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || (bucket.expiresAt <= now && (!bucket.blockedUntil || bucket.blockedUntil <= now))) {
    const fresh = { count: 0, expiresAt: now + WINDOW_MS, blockedUntil: 0 };
    buckets.set(key, fresh);
    return fresh;
  }

  return bucket;
}

/** Segundos que faltan para poder reintentar, o 0 si no está bloqueado. */
function retryAfter(keys) {
  const now = Date.now();
  let max = 0;

  for (const key of keys) {
    const bucket = buckets.get(key);
    if (bucket && bucket.blockedUntil > now) {
      max = Math.max(max, Math.ceil((bucket.blockedUntil - now) / 1000));
    }
  }

  return max;
}

/** Registra un intento fallido y bloquea la clave si supera su límite. */
function registerFailure(keys) {
  const now = Date.now();

  for (const key of keys) {
    const bucket = getBucket(key);
    const limit = LIMITS[key.split(':')[0]] || LIMITS.user;

    bucket.count++;

    if (bucket.count >= limit) {
      bucket.blockedUntil = now + BLOCK_MS;
      bucket.count = 0;
      bucket.expiresAt = now + WINDOW_MS;
    }
  }
}

/** Limpia el contador tras un intento correcto. */
function registerSuccess(keys) {
  for (const key of keys) buckets.delete(key);
}

/** Claves a vigilar para un intento de login. */
function loginKeys(ip, username) {
  return [`ip:${ip}`, `user:${String(username || '').toLowerCase()}`];
}

// Purga periódica para que el Map no crezca sin límite
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt <= now && bucket.blockedUntil <= now) buckets.delete(key);
  }
}, WINDOW_MS);

if (typeof sweeper.unref === 'function') sweeper.unref();

module.exports = { retryAfter, registerFailure, registerSuccess, loginKeys };
