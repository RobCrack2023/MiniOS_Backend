# MiniOS Backend

Backend centralizado para gestionar dispositivos ESP32 con MiniOS WiFi.

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
# Instalar dependencias
npm install

# Iniciar en desarrollo
npm run dev

# Iniciar en producción
npm start
```

## Configuración

Variables de entorno (opcional):

```bash
PORT=3001
JWT_SECRET=tu-clave-secreta-aqui
TZ=America/Argentina/Buenos_Aires  # Zona horaria del servidor (UTC-3)
```

### Zona Horaria

El sistema está configurado por defecto para **UTC-3** (Argentina/Brasil). Los timestamps se muestran en esta zona horaria tanto en el dashboard como en los logs.

Para cambiar la zona horaria:

1. **En el servidor**: Establecer la variable de entorno `TZ` antes de iniciar:
   ```bash
   export TZ=America/Sao_Paulo  # Brasil (UTC-3)
   # o
   export TZ=America/Mexico_City  # México (UTC-6)
   # o
   export TZ=Europe/Madrid  # España (UTC+1/+2)

   npm start
   ```

2. **En el frontend**: Editar `public/js/app.js` línea 709, cambiar la zona horaria:
   ```javascript
   timeZone: 'America/Argentina/Buenos_Aires'  // Cambiar aquí
   ```

**Nota**: Los timestamps se almacenan en UTC en la base de datos (buena práctica) y se convierten al mostrarlos.

## Primer Uso

1. Iniciar el servidor: `npm start`
2. Abrir en navegador: `http://localhost:3001`
3. Usuario por defecto: `admin` / `admin123`
4. **Cambiar la contraseña inmediatamente**

## API Endpoints

### Autenticación
- `POST /api/auth/login` - Iniciar sesión
- `GET /api/auth/verify` - Verificar token
- `POST /api/auth/change-password` - Cambiar contraseña

### Dispositivos
- `GET /api/devices` - Listar dispositivos
- `GET /api/devices/:id` - Obtener dispositivo
- `PUT /api/devices/:id` - Actualizar dispositivo
- `DELETE /api/devices/:id` - Eliminar dispositivo

### GPIO
- `GET /api/devices/:id/gpio` - Obtener configuración GPIO
- `POST /api/devices/:id/gpio` - Configurar GPIO
- `POST /api/devices/:id/gpio/:pin/set` - Establecer valor GPIO

### DHT
- `GET /api/devices/:id/dht` - Obtener configuración DHT
- `POST /api/devices/:id/dht` - Configurar DHT

### Firmware / OTA
- `GET /api/ota/firmware` - Listar firmware
- `POST /api/ota/firmware/upload` - Subir firmware
- `POST /api/ota/firmware/:id/activate` - Activar firmware
- `POST /api/ota/update/:deviceId` - Actualizar dispositivo
- `POST /api/ota/update-all` - Actualizar todos

## WebSocket

### Endpoints
- `/ws/device` - Conexión para dispositivos ESP32
- `/ws/dashboard` - Conexión para dashboard web

### Mensajes del Dispositivo al Backend

```json
{
  "type": "register",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "firmware_version": "1.0.0",
  "ip_address": "192.168.1.100"
}

{
  "type": "data",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "payload": {
    "temperature": 25.5,
    "humidity": 60,
    "gpio": [{"pin": 2, "value": 1}]
  }
}
```

### Mensajes del Backend al Dispositivo

```json
{
  "type": "config",
  "device_id": 1,
  "gpio": [...],
  "dht": [...],
  "ota": null
}

{
  "type": "command",
  "action": "set_gpio",
  "pin": 2,
  "value": 1
}

{
  "type": "command",
  "action": "ota_update",
  "ota_id": 1,
  "version": "1.0.1",
  "filename": "firmware.bin",
  "checksum": "abc123",
  "filesize": 512000
}
```

## Estructura del Proyecto

```
MiniOS_Backend/
├── src/
│   ├── index.js           # Entry point
│   ├── websocket.js       # WebSocket server
│   ├── db/
│   │   ├── database.js    # SQLite wrapper
│   │   └── schema.sql     # Database schema
│   └── routes/
│       ├── api.js         # REST API
│       ├── auth.js        # Authentication
│       └── ota.js         # OTA management
├── public/                # Dashboard web
├── firmware/              # Uploaded .bin files
├── minios.db              # SQLite database
└── package.json
```

## Despliegue en VPS

### Con PM2

```bash
# Instalar PM2
npm install -g pm2

# Iniciar aplicación
pm2 start src/index.js --name minios

# Auto-inicio en reboot
pm2 startup
pm2 save
```

### Con Nginx (proxy inverso)

```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Actualizar Servidor de Producción

Para actualizar el servidor con los últimos cambios del repositorio:

### Método 1: Con PM2 (Recomendado)

```bash
# Conectar al servidor VPS
ssh usuario@tu-servidor.com

# Ir al directorio del proyecto
cd /ruta/a/MiniOS_Backend

# Obtener los últimos cambios
git pull origin main

# Instalar nuevas dependencias (si las hay)
npm install

# Reiniciar la aplicación con PM2
pm2 restart minios

# Ver logs para verificar que funciona
pm2 logs minios
```

### Método 2: Sin PM2

```bash
# Conectar al servidor VPS
ssh usuario@tu-servidor.com

# Ir al directorio del proyecto
cd /ruta/a/MiniOS_Backend

# Obtener los últimos cambios
git pull origin main

# Instalar nuevas dependencias (si las hay)
npm install

# Detener el proceso actual (Ctrl+C si está corriendo en terminal)
# O encontrar y matar el proceso:
pkill -f "node src/index.js"

# Iniciar de nuevo
npm start
```

### Verificación Post-Actualización

```bash
# Verificar que el servidor está corriendo
pm2 status  # Si usas PM2

# Probar el endpoint de salud (opcional, si lo tienes configurado)
curl http://localhost:3001

# Ver logs en tiempo real
pm2 logs minios --lines 50  # Con PM2
# o
tail -f logs/app.log  # Si tienes logs configurados
```

### Rollback en Caso de Problemas

Si algo sale mal después de actualizar:

```bash
# Ver commits recientes
git log --oneline -5

# Volver al commit anterior
git reset --hard HEAD~1

# Reiniciar aplicación
pm2 restart minios
```

### Notas Importantes

- **Backup**: Siempre haz backup de la base de datos antes de actualizar:
  ```bash
  cp minios.db minios.db.backup.$(date +%Y%m%d_%H%M%S)
  ```

- **Permisos**: Asegúrate de tener permisos de escritura en el directorio
  ```bash
  ls -la
  ```

- **Variables de Entorno**: Verifica que las variables de entorno sigan configuradas correctamente después de actualizar

- **WebSocket**: Los cambios en WebSocket requieren que los dispositivos ESP32 se reconecten automáticamente

## Licencia

MIT
