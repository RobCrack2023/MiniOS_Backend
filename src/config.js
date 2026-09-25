const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('./db/database');

// Clave interna donde se persiste el secreto JWT autogenerado.
// El prefijo '_' hace que getAllSettings() nunca la exponga por la API.
const JWT_SECRET_SETTING = '_jwt_secret';

// Secretos que aparecen en el repositorio y la documentación: nunca deben usarse.
const INSECURE_SECRETS = new Set([
  'minios-secret-key-change-in-production',
  'cambia-esto-por-una-clave-segura',
  'genera-una-clave-larga-y-aleatoria-aqui'
]);

/**
 * Carga un archivo .env en process.env.
 * Node 18 no soporta --env-file y el proyecto no usa dotenv, así que sin esto
 * el .env documentado en el README quedaba sin leer y JWT_SECRET caía al default.
 * Las variables ya presentes en el entorno tienen prioridad.
 */
function loadEnvFile(envPath = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(envPath)) return false;

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
         (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }

  return true;
}

/**
 * Devuelve el secreto para firmar los JWT.
 * Orden: JWT_SECRET del entorno → secreto aleatorio persistido en la BD.
 * Nunca cae a un valor por defecto conocido.
 */
function resolveJwtSecret() {
  const fromEnv = (process.env.JWT_SECRET || '').trim();

  if (fromEnv) {
    if (INSECURE_SECRETS.has(fromEnv)) {
      throw new Error(
        'JWT_SECRET tiene el valor de ejemplo de la documentación. ' +
        'Genera uno propio: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
      );
    }
    if (fromEnv.length < 32) {
      console.warn('⚠️  JWT_SECRET tiene menos de 32 caracteres; se recomienda uno más largo.');
    }
    return fromEnv;
  }

  const stored = db.getSetting(JWT_SECRET_SETTING);
  if (stored) return stored;

  const generated = crypto.randomBytes(48).toString('hex');
  db.setSetting(JWT_SECRET_SETTING, generated);
  console.warn('🔑 JWT_SECRET no definido: se generó uno aleatorio y se guardó en la base de datos.');
  console.warn('   Para poder rotarlo o compartirlo entre instancias, defínelo en el archivo .env.');

  return generated;
}

/** Token compartido que deben presentar los dispositivos ESP32 (opcional). */
function getDeviceToken() {
  const token = (process.env.DEVICE_TOKEN || '').trim();
  return token || null;
}

/**
 * Valida el token de un dispositivo en tiempo constante.
 * Si DEVICE_TOKEN no está configurado se acepta cualquier dispositivo, para no
 * dejar fuera al firmware ya desplegado que todavía no envía el token.
 */
function checkDeviceToken(provided) {
  const expected = getDeviceToken();
  if (!expected) return true;
  if (!provided) return false;

  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extrae el token de dispositivo de la query string o de la cabecera. */
function extractDeviceToken(request) {
  return (request.query && (request.query.token || request.query.device_token)) ||
         request.headers['x-device-token'] ||
         null;
}

/**
 * Orígenes permitidos por CORS.
 * El dashboard se sirve desde el mismo origen que la API, así que por defecto no
 * hace falta CORS: devolver false evita que cualquier web hable con la API.
 */
function getAllowedOrigins() {
  const raw = (process.env.ALLOWED_ORIGINS || '').trim();
  if (!raw) return false;
  if (raw === '*') return true;

  return raw.split(',').map(o => o.trim()).filter(Boolean);
}

/**
 * Días de historial de sensores que se conservan (0 = no borrar nunca).
 * Por defecto 0: borrar datos es irreversible, así que una instalación que se
 * actualiza no debe perder su historial sin haberlo pedido. Se activa poniendo
 * DATA_RETENTION_DAYS en el .env.
 */
function getRetentionDays() {
  const raw = (process.env.DATA_RETENTION_DAYS || '').trim();
  if (!raw) return 0;

  const days = Number.parseInt(raw, 10);
  if (!Number.isInteger(days) || days < 0) {
    console.warn(`⚠️  DATA_RETENTION_DAYS inválido ("${raw}"), se deja sin purga.`);
    return 0;
  }

  return days;
}

/**
 * Grabaciones de audio que se conservan por dispositivo (0 = sin límite).
 * Por defecto 200: 10 s a 16 kHz son ~320 KB, así que ~64 MB por dispositivo.
 */
function getAudioMaxPerDevice() {
  const raw = (process.env.AUDIO_MAX_PER_DEVICE || '').trim();
  if (!raw) return 200;

  const max = Number.parseInt(raw, 10);
  if (!Number.isInteger(max) || max < 0) {
    console.warn(`⚠️  AUDIO_MAX_PER_DEVICE inválido ("${raw}"), se usa 200.`);
    return 200;
  }

  return max;
}

module.exports = {
  loadEnvFile,
  getAllowedOrigins,
  getRetentionDays,
  getAudioMaxPerDevice,
  resolveJwtSecret,
  getDeviceToken,
  checkDeviceToken,
  extractDeviceToken
};
