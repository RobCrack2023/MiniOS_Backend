const db = require('../db/database');

// ============================================
// REPORTES: historial agregado de sensores y audio
// ============================================

const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_EXPORT_ROWS = 100000;

// Intervalos "redondos" entre los que se elige el de cada consulta
const NICE_BUCKETS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
const MAX_POINTS = 300;

const METRICS = {
  temperature: { name: 'Temperatura', unit: '°C' },
  humidity:    { name: 'Humedad',     unit: '%' },
  pressure:    { name: 'Presión',     unit: 'hPa' },
  altitude:    { name: 'Altitud',     unit: 'm' },
  distance:    { name: 'Distancia',   unit: 'cm' },
  analog:      { name: 'Analógico',   unit: '' },
  gpio:        { name: 'Digital',     unit: '' }
};
const METRIC_ORDER = Object.keys(METRICS);
const SOURCE_ORDER = ['i2c', 'dht', 'ultrasonic', 'gpio', 'other'];

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } }
};

const rangeQuery = {
  type: 'object',
  properties: {
    from: { type: 'string', maxLength: 40 },
    to: { type: 'string', maxLength: 40 },
    limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 }
  }
};

/** Rango pedido, validado. Por defecto las últimas 24 h. */
function parseRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'Fechas inválidas: usa ISO 8601 (p. ej. 2026-09-27T10:00:00Z)' };
  }
  if (from >= to) {
    return { error: '"from" debe ser anterior a "to"' };
  }
  if (to - from > MAX_RANGE_DAYS * 86400000) {
    return { error: `El rango máximo es de ${MAX_RANGE_DAYS} días` };
  }

  return { from, to, fromIso: from.toISOString(), toIso: to.toISOString() };
}

/**
 * El intervalo más fino que deja el gráfico en MAX_POINTS puntos como mucho.
 * Con un objetivo exacto, un rango de "30 días" que dura unos segundos más
 * saltaba al intervalo siguiente y perdía la mitad de la resolución.
 */
function pickBucket(rangeSeconds) {
  return NICE_BUCKETS.find(b => rangeSeconds / b <= MAX_POINTS) || NICE_BUCKETS[NICE_BUCKETS.length - 1];
}

const round2 = v => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/**
 * Origen de una serie. Las lecturas anteriores a la columna `source` no lo
 * traen y se deduce como lo hacía el historial: en temperatura y humedad se
 * mira primero si hay un DHT en ese pin y después un I2C con ese id. Si hay
 * ambos (un DHT en el pin N y un I2C con id N) no hay forma de saberlo y se
 * atribuyen al DHT; las lecturas nuevas ya no tienen esa ambigüedad.
 */
function resolveSource(row, cfg) {
  if (row.source) return row.source;

  switch (row.sensor_type) {
    case 'temperature':
    case 'humidity':
      if (cfg.dht.some(d => d.pin === row.sensor_pin)) return 'dht';
      if (cfg.i2c.some(s => s.id === row.sensor_pin)) return 'i2c';
      return 'dht';
    case 'pressure':
    case 'altitude':
      return 'i2c';
    case 'distance':
      return 'ultrasonic';
    case 'gpio':
    case 'analog':
      return 'gpio';
    default:
      return 'other';
  }
}

const hex = n => '0x' + Number(n).toString(16).toUpperCase().padStart(2, '0');

/** Nombre y modelo legibles del sensor físico `source:pin`. */
function describeSensor(source, pin, cfg) {
  if (source === 'i2c') {
    const s = cfg.i2c.find(x => x.id === pin);
    return s
      ? { label: s.name || `${s.sensor_type} ${hex(s.i2c_address)}`, model: `${s.sensor_type} · ${hex(s.i2c_address)}` }
      : { label: `Sensor I2C #${pin}`, model: 'I2C · eliminado' };
  }
  if (source === 'dht') {
    const d = cfg.dht.find(x => x.pin === pin);
    return d
      ? { label: d.name || `${d.sensor_type} pin ${pin}`, model: `${d.sensor_type} · GPIO ${pin}` }
      : { label: `DHT pin ${pin}`, model: 'DHT · eliminado' };
  }
  if (source === 'ultrasonic') {
    const u = cfg.ultrasonic.find(x => x.trig_pin === pin);
    return u
      ? { label: u.name || 'HC-SR04', model: `HC-SR04 · TRIG ${u.trig_pin} / ECHO ${u.echo_pin}` }
      : { label: `HC-SR04 TRIG ${pin}`, model: 'HC-SR04 · eliminado' };
  }
  if (source === 'gpio') {
    const g = cfg.gpio.find(x => x.pin === pin);
    return g
      ? { label: g.name || `GPIO ${pin}`, model: `GPIO ${pin} · ${g.mode}` }
      : { label: `GPIO ${pin}`, model: 'GPIO · eliminado' };
  }
  return { label: pin === null ? 'Sensor' : `Sensor ${pin}`, model: '' };
}

function loadDeviceConfig(deviceId) {
  return {
    dht: db.getDhtConfigs(deviceId),
    i2c: db.getI2cConfigs(deviceId),
    ultrasonic: db.getUltrasonicConfigs(deviceId),
    gpio: db.getGpioConfigs(deviceId)
  };
}

/**
 * Arma la respuesta de sensores: una entrada por sensor físico con sus
 * magnitudes, cada una con resumen y series alineadas con `buckets`.
 * Las filas antiguas (sin source) y las nuevas del mismo sensor salen de SQL en
 * grupos distintos y aquí se funden en la misma serie.
 */
function buildSensorReport(deviceId, range) {
  const cfg = loadDeviceConfig(deviceId);
  const rangeSeconds = (range.to - range.from) / 1000;
  const bucket = pickBucket(rangeSeconds);

  // Rejilla completa: los intervalos sin lecturas quedan en null y el gráfico
  // muestra un hueco (dispositivo dormido, apagado o sin conexión)
  const first = Math.floor(range.from.getTime() / 1000 / bucket) * bucket;
  const last = Math.floor(range.to.getTime() / 1000 / bucket) * bucket;
  const grid = [];
  for (let t = first; t <= last; t += bucket) grid.push(t);
  const slot = new Map(grid.map((t, i) => [t, i]));

  const sensors = new Map();   // "source:pin" -> sensor
  const metricOf = (row) => {
    const source = resolveSource(row, cfg);
    const key = `${source}:${row.sensor_pin}`;

    if (!sensors.has(key)) {
      sensors.set(key, { key, source, pin: row.sensor_pin, ...describeSensor(source, row.sensor_pin, cfg), metrics: new Map() });
    }
    const sensor = sensors.get(key);

    if (!sensor.metrics.has(row.sensor_type)) {
      const meta = METRICS[row.sensor_type] || { name: row.sensor_type, unit: '' };
      sensor.metrics.set(row.sensor_type, {
        type: row.sensor_type,
        name: meta.name,
        unit: meta.unit,
        summary: { min: null, max: null, avg: null, count: 0, last: null, last_at: null },
        _sum: 0,
        avg: new Array(grid.length).fill(null),
        min: new Array(grid.length).fill(null),
        max: new Array(grid.length).fill(null),
        _n: new Array(grid.length).fill(0)
      });
    }
    return sensor.metrics.get(row.sensor_type);
  };

  for (const row of db.getSensorAggregates(deviceId, range.fromIso, range.toIso, bucket)) {
    const m = metricOf(row);
    const i = slot.get(row.bucket);
    if (i === undefined) continue;

    const n0 = m._n[i];
    m.avg[i] = n0 === 0 ? row.avg : (m.avg[i] * n0 + row.avg * row.n) / (n0 + row.n);
    m.min[i] = n0 === 0 ? row.min : Math.min(m.min[i], row.min);
    m.max[i] = n0 === 0 ? row.max : Math.max(m.max[i], row.max);
    m._n[i] = n0 + row.n;
  }

  for (const row of db.getSensorSummary(deviceId, range.fromIso, range.toIso)) {
    const m = metricOf(row);
    const s = m.summary;
    s.min = s.count === 0 ? row.min : Math.min(s.min, row.min);
    s.max = s.count === 0 ? row.max : Math.max(s.max, row.max);
    m._sum += row.avg * row.count;
    s.count += row.count;
  }

  for (const row of db.getSensorLast(deviceId, range.fromIso, range.toIso)) {
    const s = metricOf(row).summary;
    if (!s.last_at || row.recorded_at > s.last_at) {
      s.last = row.value;
      s.last_at = row.recorded_at;
    }
  }

  const list = [...sensors.values()].map(sensor => ({
    key: sensor.key,
    source: sensor.source,
    pin: sensor.pin,
    label: sensor.label,
    model: sensor.model,
    metrics: [...sensor.metrics.values()]
      .sort((a, b) => METRIC_ORDER.indexOf(a.type) - METRIC_ORDER.indexOf(b.type))
      .map(m => ({
        type: m.type,
        name: m.name,
        unit: m.unit,
        summary: {
          min: round2(m.summary.min),
          max: round2(m.summary.max),
          avg: round2(m.summary.count ? m._sum / m.summary.count : null),
          count: m.summary.count,
          last: round2(m.summary.last),
          last_at: m.summary.last_at
        },
        avg: m.avg.map(round2),
        min: m.min.map(round2),
        max: m.max.map(round2)
      }))
  }));

  list.sort((a, b) =>
    (SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)) || ((a.pin ?? 0) - (b.pin ?? 0)));

  return {
    from: range.fromIso,
    to: range.toIso,
    bucket_seconds: bucket,
    buckets: grid.map(t => new Date(t * 1000).toISOString()),
    sensors: list
  };
}

async function reportsRoutes(fastify, options) {

  fastify.addHook('preHandler', fastify.authenticate);

  const requireDevice = (request, reply) => {
    const device = db.getDeviceById(request.params.id);
    if (!device) reply.status(404).send({ error: 'Dispositivo no encontrado' });
    return device;
  };

  const requireRange = (request, reply) => {
    const range = parseRange(request.query);
    if (range.error) reply.status(400).send({ error: range.error });
    return range.error ? null : range;
  };

  // Sensores: resumen y series agregadas del rango
  fastify.get('/devices/:id/sensors', {
    schema: { params: idParam, querystring: rangeQuery }
  }, async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return reply;
    const range = requireRange(request, reply);
    if (!range) return reply;

    return buildSensorReport(device.id, range);
  });

  // Audio: resumen y grabaciones del rango
  fastify.get('/devices/:id/audio', {
    schema: { params: idParam, querystring: rangeQuery }
  }, async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return reply;
    const range = requireRange(request, reply);
    if (!range) return reply;

    const summary = db.getAudioSummary(device.id, range.fromIso, range.toIso);

    return {
      from: range.fromIso,
      to: range.toIso,
      summary: {
        count: summary.count,
        total_duration_ms: summary.total_duration_ms,
        total_bytes: summary.total_bytes,
        avg_rms_dbfs: round2(summary.avg_rms_dbfs),
        max_peak_dbfs: round2(summary.max_peak_dbfs)
      },
      recordings: db.getAudioRecordingsInRange(device.id, range.fromIso, range.toIso, request.query.limit)
    };
  });

  // Exportar las lecturas crudas del rango a CSV, con nombre de sensor y unidad
  fastify.get('/devices/:id/export', {
    schema: { params: idParam, querystring: rangeQuery }
  }, async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return reply;
    const range = requireRange(request, reply);
    if (!range) return reply;

    const cfg = loadDeviceConfig(device.id);
    const rows = db.getSensorRows(device.id, range.fromIso, range.toIso, MAX_EXPORT_ROWS + 1);
    const truncated = rows.length > MAX_EXPORT_ROWS;
    if (truncated) rows.length = MAX_EXPORT_ROWS;

    // Prefijo defensivo contra la inyección de fórmulas al abrir el CSV en Excel,
    // y comillas porque los nombres pueden llevar comas
    const cell = value => {
      let text = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const names = new Map();
    const lines = rows.map(r => {
      const source = resolveSource(r, cfg);
      const key = `${source}:${r.sensor_pin}`;
      if (!names.has(key)) names.set(key, describeSensor(source, r.sensor_pin, cfg));
      const { label, model } = names.get(key);
      const meta = METRICS[r.sensor_type] || { name: r.sensor_type, unit: '' };
      return [r.recorded_at, cell(label), cell(model), cell(meta.name), r.value, cell(meta.unit)].join(',');
    });

    const deviceName = (device.name || `device_${device.id}`).replace(/[^a-z0-9]/gi, '_');
    const filename = `${deviceName}_${range.fromIso.slice(0, 10)}_${range.toIso.slice(0, 10)}.csv`;

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('X-Rows-Truncated', truncated ? 'true' : 'false');

    // El BOM hace que Excel lea el UTF-8 bien (°C, Presión...)
    return '﻿' + 'fecha_utc,sensor,modelo,magnitud,valor,unidad\n' + lines.join('\n');
  });
}

module.exports = reportsRoutes;
