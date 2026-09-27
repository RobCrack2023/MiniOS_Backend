// Instancias de Chart.js de la vista Reportes. Van fuera del estado de Alpine:
// si Alpine las envuelve en su Proxy reactivo, Chart.js se rompe al redibujar.
const reportCharts = new Map();

// Paleta categórica (modo oscuro), validada contra la superficie #172233 del
// dashboard: bandas de luminosidad y croma, separación para daltonismo entre
// colores vecinos y contraste >= 3:1. El orden es parte de la validación.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

function app() {
    return {
        // Auth
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || 'null'),

        // Views
        currentView: 'devices',

        // Data
        devices: [],
        deviceData: {},
        deviceLogs: {},
        deviceLogsExpanded: {},
        firmwareList: [],

        MAX_LOG_ENTRIES: 30,

        // WebSocket
        ws: null,

        // Modal
        showDeviceModal: false,
        selectedDevice: null,
        deviceTab: 'info',
        deviceGpios: [],
        deviceDhts: [],
        deviceI2cs: [],
        deviceUltrasonics: [],

        // Audio (micrófono I2S): la configuración va en el modal, las grabaciones en Reportes
        audioConfig: null,
        audioUrls: {},       // id de grabación -> blob URL ya descargado
        audioMessage: '',

        // Control Panel
        showControlPanel: false,
        controlPanelDevice: null,
        panelGpios: [],
        panelDhts: [],
        panelI2cs: [],
        panelUltrasonics: [],
        panelSensorData: {},

        // Forms
        newGpio: { pin: '', mode: 'OUTPUT', name: '' },
        newDht: { pin: '', sensor_type: 'DHT11', name: '' },
        newI2c: { sensor_type: 'AHT20', i2c_address: 0x38, name: '' },
        // Direcciones posibles de cada sensor (la primera es la que se propone)
        i2cAddressOptions: {
            AHT20: [0x38],
            BMP280: [0x77, 0x76],   // 0x77 en los módulos AHT20 + BMP280
            BME280: [0x76, 0x77]
        },
        newUltrasonic: { trig_pin: '', echo_pin: '', name: '' },

        // I2C Scan
        i2cScanResults: [],
        isScanning: false,
        scanTimeout: null,
        scanMessage: '',

        // Reportes (historial agregado de sensores y audio)
        reports: {
            deviceId: null,
            preset: '24h',      // '1h' | '24h' | '7d' | '30d' | 'custom'
            from: '',           // datetime-local (hora local) cuando preset = 'custom'
            to: '',
            loading: false,
            error: '',
            sensors: null,      // respuesta de /api/reports/devices/:id/sensors
            audio: null,        // respuesta de /api/reports/devices/:id/audio
            updatedAt: null,
            sensorKeys: [],     // orden fijo de sensores del dispositivo (decide el color)
            keysFor: null       // dispositivo al que corresponde sensorKeys
        },
        REPORT_PRESETS: [
            { id: '1h', label: '1 hora', ms: 3600000 },
            { id: '24h', label: '24 horas', ms: 86400000 },
            { id: '7d', label: '7 días', ms: 7 * 86400000 },
            { id: '30d', label: '30 días', ms: 30 * 86400000 }
        ],
        newFirmware: { version: '', description: '', file: null },
        passwordForm: { current: '', new: '' },
        timezoneForm: { timezone: 'America/Santiago' },

        // Board GPIO mappings
        boardGpioPins: {
            'ESP32': {
                analog: [32, 33, 34, 35, 36, 39],
                digital: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27],
                all: [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39]
            },
            'ESP32-S3': {
                analog: [1, 2, 4, 5, 6, 7],
                digital: [0, 3, 14, 15, 16, 17, 18, 19, 20, 21, 36, 37, 38, 39, 40, 41, 42, 45, 46],
                all: [0, 1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 36, 37, 38, 39, 40, 41, 42, 45, 46]
            },
            'ESP32-C3': {
                analog: [0, 1, 2, 3, 4],
                digital: [5, 6, 7, 10, 18, 19, 20, 21],
                all: [0, 1, 2, 3, 4, 5, 6, 7, 10, 18, 19, 20, 21]
            },
            'ESP32-S2': {
                analog: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                digital: [0, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42],
                all: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]
            }
        },

        // Computed
        get viewTitle() {
            const titles = {
                devices: 'Dispositivos',
                reports: 'Reportes',
                firmware: 'Firmware / OTA',
                settings: 'Configuración'
            };
            return titles[this.currentView] || '';
        },

        get availablePins() {
            if (!this.selectedDevice) return [];
            const boardModel = this.selectedDevice.board_model || 'ESP32';
            return this.boardGpioPins[boardModel]?.all || this.boardGpioPins['ESP32'].all;
        },

        get availableDigitalPins() {
            if (!this.selectedDevice) return [];
            const boardModel = this.selectedDevice.board_model || 'ESP32';
            return this.boardGpioPins[boardModel]?.digital || this.boardGpioPins['ESP32'].digital;
        },

        get availableAnalogPins() {
            if (!this.selectedDevice) return [];
            const boardModel = this.selectedDevice.board_model || 'ESP32';
            return this.boardGpioPins[boardModel]?.analog || this.boardGpioPins['ESP32'].analog;
        },

        // Init
        async init() {
            if (!this.token) {
                window.location.href = '/';
                return;
            }

            // Verificar token
            try {
                const res = await this.api('/api/auth/verify');
                if (!res.valid) throw new Error();
            } catch {
                this.logout();
                return;
            }

            // Cargar datos
            await this.loadDevices();
            await this.loadFirmware();
            await this.loadTimezone();

            // Conectar WebSocket
            this.connectWebSocket();

            // Reportes: con un rango relativo ("últimas 24 h") se refresca cada
            // minuto mientras la vista está abierta; al salir se para y se liberan
            // los gráficos
            this.$watch('currentView', view => {
                if (view === 'reports') {
                    if (!this.reports.deviceId && this.devices.length) this.reports.deviceId = this.devices[0].id;
                    this.loadReports();
                    this._reportsTimer = setInterval(() => {
                        if (this.reports.preset !== 'custom' && !this.reports.loading) this.loadReports();
                    }, 60000);
                } else {
                    clearInterval(this._reportsTimer);
                    this.destroyReportCharts();
                }
            });
        },

        // API Helper
        async api(url, options = {}) {
            // Fastify responde 400 (FST_ERR_CTP_EMPTY_JSON_BODY) a un POST/PUT con
            // Content-Type JSON y cuerpo vacío: así fallaban Reiniciar, Activar
            // firmware y Escanear I2C, que no llevan cuerpo.
            const method = (options.method || 'GET').toUpperCase();
            const body = options.body ?? (['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined);

            const res = await fetch(url, {
                ...options,
                body,
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });

            if (res.status === 401) {
                this.logout();
                throw new Error('No autorizado');
            }

            return res.json();
        },

        // WebSocket
        async connectWebSocket() {
            // El WebSocket exige un ticket de un minuto; se pide uno nuevo en cada
            // (re)conexión, así el JWT de sesión nunca viaja en la URL.
            let ticket;
            try {
                const res = await this.api('/api/auth/ws-ticket', { method: 'POST', body: '{}' });
                ticket = res.ticket;
                if (!ticket) throw new Error('Sin ticket');
            } catch (err) {
                console.error('No se pudo obtener el ticket del WebSocket:', err);
                setTimeout(() => this.connectWebSocket(), 5000);
                return;
            }

            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/dashboard?ticket=${encodeURIComponent(ticket)}`;

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket conectado');
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.handleWebSocketMessage(data);
            };

            this.ws.onclose = (event) => {
                // 1008 = el servidor rechazó el ticket: la sesión ya no sirve
                if (event.code === 1008) {
                    console.warn('WebSocket rechazado por el servidor, cerrando sesión');
                    this.logout();
                    return;
                }
                console.log('WebSocket desconectado, reconectando...');
                setTimeout(() => this.connectWebSocket(), 3000);
            };

            this.ws.onerror = (err) => {
                console.error('WebSocket error:', err);
            };
        },

        handleWebSocketMessage(data) {
            switch (data.type) {
                case 'init':
                    this.devices = data.devices;
                    break;

                case 'device_online':
                    const existingIndex = this.devices.findIndex(d => d.id === data.device.id);
                    if (existingIndex >= 0) {
                        this.devices[existingIndex] = data.device;
                    } else {
                        this.devices.push(data.device);
                    }
                    break;

                case 'device_offline':
                    const device = this.devices.find(d => d.mac_address === data.mac_address);
                    if (device) {
                        device.is_online = false;
                        // Actualizar last_seen con el timestamp del backend (última conexión válida)
                        if (data.last_seen) {
                            device.last_seen = data.last_seen;
                        }
                    }
                    break;

                case 'device_data':
                    this.deviceData[data.mac_address] = {
                        ...this.deviceData[data.mac_address],
                        ...data.payload
                    };
                    // Registrar entrada en el log de transmisiones
                    if (!this.deviceLogs[data.mac_address]) this.deviceLogs[data.mac_address] = [];
                    this.deviceLogs[data.mac_address].unshift(this.buildLogEntry(data.payload));
                    if (this.deviceLogs[data.mac_address].length > this.MAX_LOG_ENTRIES)
                        this.deviceLogs[data.mac_address].pop();
                    // Marcar dispositivo como online y actualizar last_seen desde el backend
                    const deviceSending = this.devices.find(d => d.mac_address === data.mac_address);
                    if (deviceSending) {
                        deviceSending.is_online = true;
                        // Actualizar last_seen con el timestamp del backend
                        if (data.last_seen) {
                            deviceSending.last_seen = data.last_seen;
                        }
                    }
                    // Actualizar Panel de Control si está abierto
                    if (this.showControlPanel && this.controlPanelDevice && data.mac_address === this.controlPanelDevice.mac_address) {
                        // Actualizar GPIOs
                        if (data.payload.gpio) {
                            data.payload.gpio.forEach(g => {
                                const gpio = this.panelGpios.find(pg => pg.pin === g.pin);
                                if (gpio) {
                                    gpio.value = g.value;
                                    gpio.isAnalog = g.analog;
                                }
                            });
                        }

                        // Actualizar DHT
                        if (data.payload.dht) {
                            if (!this.panelSensorData.dht) this.panelSensorData.dht = {};
                            data.payload.dht.forEach(d => {
                                this.panelSensorData.dht[d.pin] = {
                                    temperature: d.temperature,
                                    humidity: d.humidity
                                };
                            });
                        }

                        // Actualizar I2C
                        if (data.payload.i2c) {
                            if (!this.panelSensorData.i2c) this.panelSensorData.i2c = {};
                            data.payload.i2c.forEach(s => {
                                this.panelSensorData.i2c[s.id] = {
                                    temperature: s.temperature,
                                    humidity: s.humidity,
                                    pressure: s.pressure,
                                    altitude: s.altitude
                                };
                            });
                        }
                    }
                    break;

                case 'ota_status':
                    console.log('OTA Status:', data);
                    break;

                case 'audio_recording':
                    if (this.showDeviceModal && this.selectedDevice?.id === data.device_id) {
                        this.audioMessage = '✅ Grabación recibida: escúchala en Reportes';
                    }
                    // Con un rango relativo la grabación nueva entra en el rango: se recarga
                    if (this.currentView === 'reports' && this.reports.deviceId === data.device_id &&
                        this.reports.preset !== 'custom') {
                        this.loadAudioReport();
                    }
                    break;

                case 'i2c_scan_result':
                    console.log('Resultado escaneo I2C:', data.devices);
                    this.i2cScanResults = data.devices;
                    this.isScanning = false;

                    // Limpiar timeout
                    if (this.scanTimeout) {
                        clearTimeout(this.scanTimeout);
                        this.scanTimeout = null;
                    }

                    // Mostrar mensaje según resultados
                    if (data.devices.length === 0) {
                        this.scanMessage = '⚠️ No se encontraron dispositivos I2C. Verifica las conexiones (SDA/SCL).';
                        setTimeout(() => { this.scanMessage = ''; }, 5000);
                    } else {
                        this.scanMessage = `✅ Se encontraron ${data.devices.length} dispositivo(s) I2C`;
                        setTimeout(() => { this.scanMessage = ''; }, 3000);
                    }
                    break;
            }
        },

        // Devices
        async loadDevices() {
            const data = await this.api('/api/devices');
            this.devices = data.devices;
        },

        async openDeviceModal(device) {
            this.selectedDevice = {
                ...device,
                sleep_interval_s: Math.round((device.sleep_interval || 60000) / 1000)
            };
            this.deviceTab = 'info';

            // Cargar configuraciones
            const data = await this.api(`/api/devices/${device.id}`);
            this.deviceGpios = data.gpio || [];
            this.deviceDhts = data.dht || [];
            this.deviceI2cs = data.i2c || [];
            this.deviceUltrasonics = data.ultrasonic || [];
            await this.loadAudio(device.id);

            this.showDeviceModal = true;
        },

        async saveDevice() {
            await this.api(`/api/devices/${this.selectedDevice.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name: this.selectedDevice.name,
                    description: this.selectedDevice.description,
                    sleep_interval: this.selectedDevice.sleep_interval
                })
            });

            await this.loadDevices();
            this.showDeviceModal = false;
        },

        // Control Panel
        async openControlPanel(device) {
            this.controlPanelDevice = { ...device };

            // Cargar configuraciones
            const data = await this.api(`/api/devices/${device.id}`);
            this.panelGpios = data.gpio || [];
            this.panelDhts = data.dht || [];
            this.panelI2cs = data.i2c || [];
            this.panelUltrasonics = data.ultrasonic || [];

            // Reset sensor data
            this.panelSensorData = {};

            // Inicializar valores de GPIO desde deviceData
            const currentData = this.deviceData[device.mac_address];
            if (currentData) {
                if (currentData.gpio) {
                    currentData.gpio.forEach(g => {
                        const gpio = this.panelGpios.find(pg => pg.pin === g.pin);
                        if (gpio) {
                            gpio.value = g.value;
                            gpio.isAnalog = g.analog;
                        }
                    });
                }
                if (currentData.dht) {
                    this.panelSensorData.dht = {};
                    currentData.dht.forEach(d => {
                        this.panelSensorData.dht[d.pin] = {
                            temperature: d.temperature,
                            humidity: d.humidity
                        };
                    });
                }
                if (currentData.i2c) {
                    this.panelSensorData.i2c = {};
                    currentData.i2c.forEach(s => {
                        this.panelSensorData.i2c[s.id] = {
                            temperature: s.temperature,
                            humidity: s.humidity,
                            pressure: s.pressure,
                            altitude: s.altitude
                        };
                    });
                }
            }

            this.showControlPanel = true;
        },

        closeControlPanel() {
            this.showControlPanel = false;
            this.controlPanelDevice = null;
        },

        async togglePanelGpio(gpio) {
            const newValue = gpio.value ? 0 : 1;
            await this.api(`/api/devices/${this.controlPanelDevice.id}/gpio/${gpio.pin}/set`, {
                method: 'POST',
                body: JSON.stringify({ value: newValue })
            });
            gpio.value = newValue;
        },

        async setPanelGpioValue(gpio) {
            await this.api(`/api/devices/${this.controlPanelDevice.id}/gpio/${gpio.pin}/set`, {
                method: 'POST',
                body: JSON.stringify({ value: parseInt(gpio.value) })
            });
        },

        async rebootDevice(device) {
            if (!confirm(`¿Reiniciar ${device.name}?`)) return;

            try {
                await this.api(`/api/devices/${device.id}/reboot`, { method: 'POST' });
                alert('Comando de reinicio enviado');
            } catch (err) {
                alert('Error al reiniciar dispositivo');
            }
        },

        // GPIO
        async addGpio() {
            if (!this.newGpio.pin) return;

            await this.api(`/api/devices/${this.selectedDevice.id}/gpio`, {
                method: 'POST',
                body: JSON.stringify(this.newGpio)
            });

            const data = await this.api(`/api/devices/${this.selectedDevice.id}/gpio`);
            this.deviceGpios = data.gpio;
            this.newGpio = { pin: '', mode: 'OUTPUT', name: '' };
        },

        async deleteGpio(pin) {
            await this.api(`/api/devices/${this.selectedDevice.id}/gpio/${pin}`, {
                method: 'DELETE'
            });

            this.deviceGpios = this.deviceGpios.filter(g => g.pin !== pin);
        },

        async toggleGpio(gpio) {
            const newValue = gpio.value ? 0 : 1;
            await this.setGpioValue({ ...gpio, value: newValue });
            gpio.value = newValue;
        },

        async setGpioValue(gpio) {
            await this.api(`/api/devices/${this.selectedDevice.id}/gpio/${gpio.pin}/set`, {
                method: 'POST',
                body: JSON.stringify({ value: parseInt(gpio.value) })
            });
        },

        // DHT
        async addDht() {
            if (!this.newDht.pin) return;

            await this.api(`/api/devices/${this.selectedDevice.id}/dht`, {
                method: 'POST',
                body: JSON.stringify(this.newDht)
            });

            const data = await this.api(`/api/devices/${this.selectedDevice.id}/dht`);
            this.deviceDhts = data.dht;
            this.newDht = { pin: '', sensor_type: 'DHT11', name: '' };
        },

        async deleteDht(pin) {
            await this.api(`/api/devices/${this.selectedDevice.id}/dht/${pin}`, {
                method: 'DELETE'
            });

            this.deviceDhts = this.deviceDhts.filter(d => d.pin !== pin);
        },

        // I2C Sensors
        onI2cTypeChange() {
            // Antes la dirección se quedaba en 0x38 al elegir BMP280, y como el
            // backend identifica cada sensor por su dirección, el "+" sobrescribía
            // el AHT20 en vez de añadir un segundo sensor
            this.newI2c.i2c_address = this.i2cAddressOptions[this.newI2c.sensor_type][0];
        },

        async addI2c() {
            const { sensor_type, i2c_address } = this.newI2c;
            if (!sensor_type || !i2c_address) return;

            const hex = '0x' + i2c_address.toString(16).toUpperCase();
            const existing = this.deviceI2cs.find(s => s.i2c_address === i2c_address);
            if (existing && existing.sensor_type !== sensor_type) {
                this.scanMessage = `❌ En ${hex} ya hay un ${existing.sensor_type}. Dos sensores no pueden compartir dirección: elige otra o borra el existente.`;
                setTimeout(() => { this.scanMessage = ''; }, 6000);
                return;
            }

            const res = await this.api(`/api/devices/${this.selectedDevice.id}/i2c`, {
                method: 'POST',
                body: JSON.stringify({
                    ...this.newI2c,
                    name: this.newI2c.name || `${sensor_type} ${hex}`
                })
            });

            if (res.error) {
                this.scanMessage = `❌ ${res.message || res.error}`;
                setTimeout(() => { this.scanMessage = ''; }, 6000);
                return;
            }

            this.deviceI2cs = res.i2c;
            this.newI2c = { sensor_type: 'AHT20', i2c_address: 0x38, name: '' };
            this.scanMessage = `✅ ${sensor_type} en ${hex} agregado`;
            setTimeout(() => { this.scanMessage = ''; }, 3000);
        },

        async deleteI2c(address) {
            await this.api(`/api/devices/${this.selectedDevice.id}/i2c/${address}`, {
                method: 'DELETE'
            });

            this.deviceI2cs = this.deviceI2cs.filter(i => i.i2c_address !== address);
        },

        async scanI2c() {
            if (!this.selectedDevice) return;

            // Verificar si el dispositivo está online
            if (!this.selectedDevice.is_online) {
                this.scanMessage = '⚠️ Dispositivo en Deep Sleep. Esperando a que despierte...';
                this.isScanning = true;
                this.i2cScanResults = [];
            } else {
                this.scanMessage = '🔍 Escaneando bus I2C...';
                this.isScanning = true;
                this.i2cScanResults = [];
            }

            // Configurar timeout de 80 segundos
            // (60s Deep Sleep + 20s tareas + 15s ventana de comandos = ~95s max)
            if (this.scanTimeout) {
                clearTimeout(this.scanTimeout);
            }

            this.scanTimeout = setTimeout(() => {
                if (this.isScanning) {
                    this.isScanning = false;
                    this.scanMessage = '❌ Timeout: El dispositivo no respondió. Verifica que esté encendido y conectado.';
                    setTimeout(() => { this.scanMessage = ''; }, 5000);
                }
            }, 80000); // 80 segundos

            try {
                await this.api(`/api/devices/${this.selectedDevice.id}/i2c/scan`, {
                    method: 'POST'
                });
                // Los resultados llegarán por WebSocket
                this.scanMessage = '⏳ Comando enviado. Esperando respuesta del dispositivo...';
            } catch (err) {
                console.error('Error solicitando escaneo I2C:', err);
                this.isScanning = false;
                this.scanMessage = '❌ Error al solicitar escaneo: ' + err.message;
                setTimeout(() => { this.scanMessage = ''; }, 5000);
                if (this.scanTimeout) {
                    clearTimeout(this.scanTimeout);
                }
            }
        },

        selectI2cDevice(device) {
            this.newI2c.sensor_type = device.sensor_type !== 'Unknown' ? device.sensor_type : 'AHT20';
            this.newI2c.i2c_address = device.address;

            // Generar nombre sugerido si está vacío
            if (!this.newI2c.name) {
                const sensorName = device.sensor_type !== 'Unknown' ? device.sensor_type : 'Sensor';
                this.newI2c.name = `${sensorName} 0x${device.address.toString(16).toUpperCase()}`;
            }

            this.scanMessage = `✅ Sensor seleccionado. Completa el nombre y haz clic en "+"`;
            setTimeout(() => { this.scanMessage = ''; }, 3000);
        },

        async addI2cAuto(device) {
            // Agregar sensor I2C automáticamente con un solo clic
            const sensorName = device.sensor_type !== 'Unknown' ? device.sensor_type : 'Sensor';
            const autoName = `${sensorName} 0x${device.address.toString(16).toUpperCase()}`;

            const i2cData = {
                sensor_type: device.sensor_type !== 'Unknown' ? device.sensor_type : 'AHT20',
                i2c_address: device.address,
                name: autoName,
                active: true,
                read_interval: 5000
            };

            await this.api(`/api/devices/${this.selectedDevice.id}/i2c`, {
                method: 'POST',
                body: JSON.stringify(i2cData)
            });

            await this.loadDeviceConfig(this.selectedDevice.id);

            // Limpiar resultados después de agregar
            this.scanMessage = `✅ ${autoName} agregado correctamente`;
            setTimeout(() => {
                this.scanMessage = '';
                this.i2cScanResults = [];
            }, 3000);
        },

        // Ultrasonic
        async addUltrasonic() {
            if (!this.newUltrasonic.trig_pin || !this.newUltrasonic.echo_pin) return;

            await this.api(`/api/devices/${this.selectedDevice.id}/ultrasonic`, {
                method: 'POST',
                body: JSON.stringify(this.newUltrasonic)
            });

            const data = await this.api(`/api/devices/${this.selectedDevice.id}/ultrasonic`);
            this.deviceUltrasonics = data.ultrasonic;
            this.newUltrasonic = { trig_pin: '', echo_pin: '', name: '' };
        },

        async updateUltrasonic(ultrasonic) {
            await this.api(`/api/devices/${this.selectedDevice.id}/ultrasonic`, {
                method: 'POST',
                body: JSON.stringify(ultrasonic)
            });
        },

        async deleteUltrasonic(id) {
            await this.api(`/api/devices/${this.selectedDevice.id}/ultrasonic/${id}`, {
                method: 'DELETE'
            });

            this.deviceUltrasonics = this.deviceUltrasonics.filter(u => u.id !== id);
        },

        // Audio
        // Pines por defecto que no chocan con I2C ni con el LED de cada placa
        defaultAudioConfig(boardModel) {
            const pins = {
                'ESP32-C3': [6, 7, 5],
                'ESP32-S3': [15, 16, 17],
                'ESP32-S2': [15, 16, 17],
                'ESP32': [26, 25, 33]
            }[boardModel] || [26, 25, 33];

            return {
                enabled: false,
                sck_pin: pins[0], ws_pin: pins[1], sd_pin: pins[2],
                channel: 0, sample_rate: 16000, duration_sec: 10,
                capture_interval_sec: 300, gain: 16
            };
        },

        // El modal solo configura el micrófono: las grabaciones están en Reportes
        async loadAudio(deviceId) {
            this.audioMessage = '';
            const data = await this.api(`/api/devices/${deviceId}/audio?limit=1`);
            this.audioConfig = data.config || this.defaultAudioConfig(this.selectedDevice?.board_model);
        },

        async saveAudioConfig() {
            const data = await this.api(`/api/devices/${this.selectedDevice.id}/audio/config`, {
                method: 'PUT',
                body: JSON.stringify(this.audioConfig)
            });

            if (data.error) {
                this.audioMessage = `❌ ${data.error}`;
                return;
            }

            this.audioConfig = data.config;
            this.audioMessage = '✅ Configuración guardada';
            setTimeout(() => { if (this.audioMessage.startsWith('✅')) this.audioMessage = ''; }, 3000);
        },

        async requestAudioCapture() {
            const data = await this.api(`/api/devices/${this.selectedDevice.id}/audio/capture`, { method: 'POST' });
            this.audioMessage = data.error
                ? `❌ ${data.error}`
                : `⏳ ${data.message} (${this.audioConfig.duration_sec} s + subida)`;
        },

        async fetchRecording(rec) {
            if (this.audioUrls[rec.id]) return this.audioUrls[rec.id];

            // El WAV se pide con el JWT en la cabecera y se reproduce desde un blob
            const res = await fetch(`/api/audio/${rec.id}/file`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const url = URL.createObjectURL(await res.blob());
            this.audioUrls[rec.id] = url;
            return url;
        },

        async playRecording(rec) {
            try {
                await this.fetchRecording(rec);
            } catch (err) {
                this.reports.error = `No se pudo cargar la grabación (${err.message})`;
            }
        },

        async downloadRecording(rec) {
            try {
                const a = document.createElement('a');
                a.href = await this.fetchRecording(rec);
                a.download = rec.filename;
                a.click();
            } catch (err) {
                this.reports.error = `No se pudo descargar la grabación (${err.message})`;
            }
        },

        async deleteRecording(rec) {
            if (!confirm('¿Eliminar esta grabación?')) return;

            await this.api(`/api/audio/${rec.id}`, { method: 'DELETE' });

            if (this.audioUrls[rec.id]) {
                URL.revokeObjectURL(this.audioUrls[rec.id]);
                delete this.audioUrls[rec.id];
            }
            // Se recarga para que el resumen y el gráfico de niveles cuadren
            await this.loadAudioReport();
        },

        formatDuration(ms) {
            return `${(ms / 1000).toFixed(1)} s`;
        },

        buildLogEntry(payload) {
            const time = new Date().toLocaleTimeString('es-CL', { hour12: false });
            const parts = [];
            if (payload.dht?.length) parts.push(payload.dht.map(d => {
                const vals = [];
                if (d.temperature != null) vals.push(d.temperature.toFixed(1) + '°C');
                if (d.humidity    != null) vals.push(d.humidity.toFixed(0) + '%');
                return `${d.name||'DHT'} ${vals.join(' ')}`;
            }).join(' | '));
            if (payload.i2c?.length) parts.push(payload.i2c.map(s => {
                const vals = [];
                if (s.temperature != null) vals.push(s.temperature.toFixed(1) + '°C');
                if (s.humidity    != null) vals.push(s.humidity.toFixed(0) + '%');
                if (s.pressure    != null) vals.push(s.pressure.toFixed(0) + 'hPa');
                if (s.altitude    != null) vals.push(s.altitude.toFixed(0) + 'm');
                return `${s.name||s.sensor_type} ${vals.join(' ')}`;
            }).join(' | '));
            if (payload.gpio?.length)       parts.push('GPIO: ' + payload.gpio.map(g => `${g.name||('P'+g.pin)}=${g.value}`).join(' '));
            if (payload.ultrasonic?.length) parts.push(payload.ultrasonic.map(u => {
                const vals = [];
                if (u.distance != null) vals.push(u.distance.toFixed(0) + 'cm');
                return `${u.name||'US'} ${vals.join(' ')}`;
            }).join(' | '));
            return { time, text: parts.join(' · ') || 'Sin datos', raw: payload };
        },

        toggleDeviceLog(mac) {
            this.deviceLogsExpanded[mac] = !this.deviceLogsExpanded[mac];
        },

        // Helper: formato tiempo relativo
        timeAgo(date) {
            if (!date) return 'Nunca';
            const seconds = Math.floor((new Date() - date) / 1000);
            if (seconds < 5) return 'Ahora';
            if (seconds < 60) return `Hace ${seconds}s`;
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return `Hace ${minutes}m`;
            const hours = Math.floor(minutes / 60);
            return `Hace ${hours}h`;
        },

        // Firmware
        async loadFirmware() {
            const data = await this.api('/api/ota/firmware');
            this.firmwareList = data.firmware;
        },

        async uploadFirmware() {
            if (!this.newFirmware.file) return;

            const formData = new FormData();
            formData.append('file', this.newFirmware.file);
            formData.append('version', this.newFirmware.version);
            formData.append('description', this.newFirmware.description);

            const res = await fetch('/api/ota/firmware/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });

            if (res.ok) {
                await this.loadFirmware();
                this.newFirmware = { version: '', description: '', file: null };
                alert('Firmware subido correctamente');
            } else {
                alert('Error al subir firmware');
            }
        },

        async activateFirmware(id) {
            await this.api(`/api/ota/firmware/${id}/activate`, { method: 'POST' });
            await this.loadFirmware();
        },

        async deleteFirmware(id) {
            if (!confirm('¿Eliminar este firmware?')) return;

            await this.api(`/api/ota/firmware/${id}`, { method: 'DELETE' });
            await this.loadFirmware();
        },

        async updateAllDevices(firmwareId) {
            if (!confirm('¿Enviar actualización a todos los dispositivos?')) return;

            const data = await this.api('/api/ota/update-all', {
                method: 'POST',
                body: JSON.stringify({ firmware_id: firmwareId })
            });

            alert(`Actualización enviada a ${data.tasks_created} dispositivos`);
        },

        // Settings
        async changePassword() {
            try {
                await this.api('/api/auth/change-password', {
                    method: 'POST',
                    body: JSON.stringify({
                        currentPassword: this.passwordForm.current,
                        newPassword: this.passwordForm.new
                    })
                });

                alert('Contraseña cambiada correctamente');
                this.passwordForm = { current: '', new: '' };
            } catch (err) {
                alert('Error al cambiar contraseña');
            }
        },

        // Auth
        logout() {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = '/';
        },

        // Helpers
        formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },

        formatDate(dateString) {
            // Mostrar en zona horaria configurada en el servidor
            return new Date(dateString).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: this.timezoneForm.timezone
            });
        },

        // Cargar timezone
        async loadTimezone() {
            try {
                const data = await this.api('/api/settings/timezone');
                this.timezoneForm.timezone = data.timezone;
            } catch (error) {
                console.error('Error cargando timezone:', error);
            }
        },

        // Cargar configuración completa de un dispositivo
        async loadDeviceConfig(deviceId) {
            const data = await this.api(`/api/devices/${deviceId}`);
            this.deviceGpios = data.gpio || [];
            this.deviceDhts = data.dht || [];
            this.deviceI2cs = data.i2c || [];
            this.deviceUltrasonics = data.ultrasonic || [];
        },

        // ============================================
        // REPORTES
        // ============================================

        openReports(device) {
            this.showDeviceModal = false;
            this.reports.deviceId = device.id;
            if (this.currentView === 'reports') {
                this.onReportDeviceChange();
            } else {
                this.currentView = 'reports';   // el $watch de init() carga los datos
            }
        },

        get reportDevice() {
            return this.devices.find(d => d.id === this.reports.deviceId) || null;
        },

        onReportDeviceChange() {
            this.destroyReportCharts();
            this.reports.sensors = null;
            this.reports.audio = null;
            this.loadReports();
        },

        // Rango en ISO 8601. Los relativos se recalculan en cada carga ("últimas 24 h" avanza)
        reportRange() {
            if (this.reports.preset === 'custom') {
                const from = this.reports.from ? new Date(this.reports.from) : null;
                const to = this.reports.to ? new Date(this.reports.to) : new Date();
                if (!from || isNaN(from) || isNaN(to)) return null;
                return { from: from.toISOString(), to: to.toISOString() };
            }
            const preset = this.REPORT_PRESETS.find(p => p.id === this.reports.preset) || this.REPORT_PRESETS[1];
            const now = Date.now();
            return { from: new Date(now - preset.ms).toISOString(), to: new Date(now).toISOString() };
        },

        reportQuery() {
            const range = this.reportRange();
            return range ? `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : null;
        },

        setReportPreset(id) {
            this.reports.preset = id;
            if (id === 'custom' && !this.reports.from) {
                // Se propone el último día como punto de partida del rango personalizado
                const toLocalInput = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                this.reports.to = toLocalInput(new Date());
                this.reports.from = toLocalInput(new Date(Date.now() - 86400000));
            }
            this.loadReports();
        },

        // Orden fijo de los sensores del dispositivo según su configuración: el color
        // de cada uno sale de aquí, así no cambia aunque otro sensor no tenga datos
        async loadReportSensorKeys() {
            const cfg = await this.api(`/api/devices/${this.reports.deviceId}`);
            this.reports.sensorKeys = [
                ...(cfg.i2c || []).map(s => `i2c:${s.id}`),
                ...(cfg.dht || []).map(d => `dht:${d.pin}`),
                ...(cfg.ultrasonic || []).map(u => `ultrasonic:${u.trig_pin}`),
                ...(cfg.gpio || []).filter(g => g.mode.includes('INPUT')).map(g => `gpio:${g.pin}`)
            ];
            this.reports.keysFor = this.reports.deviceId;
        },

        reportColor(key) {
            const i = this.reports.sensorKeys.indexOf(key);
            // Pasado el octavo color no se inventa otro: los sensores sin color propio
            // (o ya eliminados de la configuración) van en gris neutro
            return i >= 0 && i < SERIES_COLORS.length ? SERIES_COLORS[i] : '#7d93ab';
        },

        async loadReports() {
            if (!this.reports.deviceId) return;
            const query = this.reportQuery();
            if (!query) {
                this.reports.error = 'Elige la fecha de inicio del rango.';
                return;
            }

            this.reports.loading = true;
            this.reports.error = '';
            try {
                if (this.reports.keysFor !== this.reports.deviceId) await this.loadReportSensorKeys();

                const id = this.reports.deviceId;
                const [sensors, audio] = await Promise.all([
                    this.api(`/api/reports/devices/${id}/sensors?${query}`),
                    this.api(`/api/reports/devices/${id}/audio?${query}`)
                ]);
                if (sensors.error || audio.error) throw new Error(sensors.error || audio.error);

                this.reports.sensors = sensors;
                this.reports.audio = audio;
                this.reports.updatedAt = new Date();
            } catch (err) {
                this.reports.error = err.message;
            } finally {
                this.reports.loading = false;
            }

            this.$nextTick(() => this.renderReportCharts());
        },

        async loadAudioReport() {
            const query = this.reportQuery();
            if (!query || !this.reports.deviceId) return;

            const audio = await this.api(`/api/reports/devices/${this.reports.deviceId}/audio?${query}`);
            if (audio.error) {
                this.reports.error = audio.error;
                return;
            }
            this.reports.audio = audio;
            this.$nextTick(() => this.renderAudioChart());
        },

        // Una tarjeta por magnitud (Temperatura, Humedad...) con una línea por sensor
        get reportMetricGroups() {
            const data = this.reports.sensors;
            if (!data) return [];

            const groups = new Map();
            for (const sensor of data.sensors) {
                for (const metric of sensor.metrics) {
                    if (!groups.has(metric.type)) {
                        groups.set(metric.type, { type: metric.type, name: metric.name, unit: metric.unit, series: [] });
                    }
                    groups.get(metric.type).series.push({ sensor, metric, color: this.reportColor(sensor.key) });
                }
            }
            return [...groups.values()];
        },

        formatReportValue(value, type) {
            if (value === null || value === undefined) return '—';
            const decimals = { temperature: 1, humidity: 0, pressure: 1, altitude: 0, distance: 0, gpio: 0 }[type];
            return Number(value).toFixed(decimals ?? 2);
        },

        formatBucketSize(seconds) {
            if (seconds < 3600) return `${seconds / 60} min`;
            if (seconds < 86400) return `${seconds / 3600} h`;
            return `${seconds / 86400} d`;
        },

        destroyReportCharts() {
            reportCharts.forEach(chart => chart.destroy());
            reportCharts.clear();
        },

        // Tooltip y ejes con los tokens del tema oscuro
        reportChartBase() {
            return {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    tooltip: {
                        backgroundColor: '#233450',
                        borderColor: '#335070',
                        borderWidth: 1,
                        titleColor: '#e8f4ff',
                        bodyColor: '#9db8d4',
                        padding: 10,
                        boxPadding: 4
                    }
                }
            };
        },

        // Eje X de tiempo real (ms), con marcas en horas o días redondos. Un eje de
        // categorías no sirve: spanGaps numérico solo salva puntos ausentes, no null
        reportTimeAxis(fromMs, toMs) {
            const rangeMs = toMs - fromMs;
            const STEPS = [300e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3];
            const timeZone = this.timezoneForm.timezone;

            // Desfase de la zona horaria configurada: sin él las marcas diarias caían
            // en la medianoche UTC (las 21:00 en Chile)
            const at = new Date(fromMs);
            const offset = Date.parse(at.toLocaleString('en-US', { timeZone })) -
                           Date.parse(at.toLocaleString('en-US', { timeZone: 'UTC' }));

            // Paso de las marcas según el rango y el ancho del gráfico: en un móvil
            // caben menos etiquetas antes de que se pisen
            const pickStep = width => {
                const maxTicks = Math.max(2, Math.min(8, Math.floor(width / 95)));
                return STEPS.find(s => rangeMs / s <= maxTicks) || STEPS[STEPS.length - 1];
            };
            let step = pickStep(800);

            const time = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
            const formatFor = s => s >= 86400e3 ? { day: 'numeric', month: 'short' }
                                 : rangeMs <= 86400e3 ? time
                                 : { day: 'numeric', month: 'short', ...time };

            return {
                type: 'linear',
                min: fromMs,
                max: toMs,
                grid: { display: false },
                afterBuildTicks: axis => {
                    step = pickStep(axis.chart.width);
                    const ticks = [];
                    for (let t = Math.ceil((fromMs + offset) / step) * step - offset; t <= toMs; t += step) {
                        ticks.push({ value: t });
                    }
                    axis.ticks = ticks;
                },
                ticks: {
                    color: '#5a7a98',
                    maxRotation: 0,
                    callback: v => new Date(v).toLocaleString('es-CL', { timeZone, ...formatFor(step) })
                }
            };
        },

        renderReportCharts() {
            this.destroyReportCharts();
            const data = this.reports.sensors;
            if (!data) return;

            const fromMs = Date.parse(data.from);
            const toMs = Date.parse(data.to);
            const times = data.buckets.map(t => Date.parse(t));
            const bucketMs = data.bucket_seconds * 1000;
            const base = this.reportChartBase();

            // Qué cuenta como hueco: un dispositivo con deep sleep envía una vez por
            // ciclo, y si el ciclo es más largo que el intervalo del gráfico muchos
            // intervalos quedan vacíos sin que haya pasado nada. La línea solo se corta
            // si faltan datos durante más de dos ciclos (y nunca entre intervalos seguidos).
            const cycleMs = (this.reportDevice?.sleep_interval || 60000) + 20000;
            const gapMs = Math.max(1.5 * bucketMs, 2 * cycleMs);

            // Solo los intervalos con datos; así spanGaps puede unir los que estén cerca
            const toPoints = (values, extra = () => ({})) => values
                .map((v, i) => (v == null ? null : { x: times[i], y: v, ...extra(i) }))
                .filter(Boolean);

            // Un valor sin vecinos a menos de gapMs no dibuja segmento: se muestra como punto
            const isolatedRadius = ctx => {
                const pts = ctx.dataset.data;
                const p = pts[ctx.dataIndex];
                if (!p) return 0;
                const prev = pts[ctx.dataIndex - 1];
                const next = pts[ctx.dataIndex + 1];
                const joined = (prev && p.x - prev.x <= gapMs) || (next && next.x - p.x <= gapMs);
                return joined ? 0 : 2.5;
            };

            for (const group of this.reportMetricGroups) {
                const canvas = document.getElementById(`report-chart-${group.type}`);
                if (!canvas) continue;
                Chart.getChart(canvas)?.destroy();

                const single = group.series.length === 1;
                const datasets = [];

                for (const { sensor, metric, color } of group.series) {
                    datasets.push({
                        label: sensor.label,
                        data: toPoints(metric.avg, i => ({ min: metric.min[i], max: metric.max[i] })),
                        borderColor: color,
                        backgroundColor: color,
                        borderWidth: 2,
                        pointRadius: isolatedRadius,
                        pointHoverRadius: 4,
                        pointHitRadius: 10,
                        tension: 0,
                        spanGaps: gapMs
                    });

                    // Banda mín–máx de cada intervalo: solo con una serie, con varias satura
                    if (single) {
                        datasets.push({ label: 'máx', data: toPoints(metric.max), borderWidth: 0, pointRadius: 0, pointHitRadius: 0,
                                        fill: '+1', backgroundColor: color + '2e', spanGaps: gapMs, _band: true });
                        datasets.push({ label: 'mín', data: toPoints(metric.min), borderWidth: 0, pointRadius: 0, pointHitRadius: 0,
                                        fill: false, spanGaps: gapMs, _band: true });
                    }
                }

                const unit = group.unit ? ` ${group.unit}` : '';
                const fmt = v => this.formatReportValue(v, group.type);

                reportCharts.set(group.type, new Chart(canvas, {
                    type: 'line',
                    data: { datasets },
                    options: {
                        ...base,
                        // Cada sensor puede tener huecos distintos: se agrupa por instante, no por índice
                        interaction: { mode: 'nearest', axis: 'x', intersect: false },
                        plugins: {
                            ...base.plugins,
                            legend: {
                                display: !single,
                                labels: { color: '#9db8d4', boxWidth: 12, boxHeight: 2, filter: item => !datasets[item.datasetIndex]._band }
                            },
                            tooltip: {
                                ...base.plugins.tooltip,
                                filter: item => !item.dataset._band,
                                callbacks: {
                                    title: items => this.formatDate(new Date(items[0].raw.x).toISOString()),
                                    label: ctx => {
                                        const p = ctx.raw;
                                        return ` ${ctx.dataset.label}: ${fmt(p.y)}${unit}  (mín ${fmt(p.min)} · máx ${fmt(p.max)})`;
                                    }
                                }
                            }
                        },
                        scales: {
                            x: this.reportTimeAxis(fromMs, toMs),
                            y: {
                                grid: { color: 'rgba(157,184,212,0.10)' },
                                border: { display: false },
                                ticks: { color: '#5a7a98' },
                                title: { display: !!group.unit, text: group.unit, color: '#5a7a98' }
                            }
                        }
                    }
                }));
            }

            this.renderAudioChart();
        },

        // Nivel de cada grabación en el tiempo: eje X lineal con la hora real, porque
        // las grabaciones no llegan a intervalos regulares
        renderAudioChart() {
            reportCharts.get('audio')?.destroy();
            reportCharts.delete('audio');

            const canvas = document.getElementById('report-chart-audio');
            const audio = this.reports.audio;
            const recs = audio?.recordings || [];
            if (!canvas || recs.length === 0) return;
            Chart.getChart(canvas)?.destroy();

            const ordered = [...recs].reverse();
            const from = Date.parse(audio.from);
            const to = Date.parse(audio.to);
            const base = this.reportChartBase();

            const point = (key, rec) => ({ x: Date.parse(rec.recorded_at), y: rec[key], rec });

            reportCharts.set('audio', new Chart(canvas, {
                type: 'scatter',
                data: {
                    datasets: [
                        { label: 'Nivel medio', data: ordered.map(r => point('rms_dbfs', r)),
                          backgroundColor: SERIES_COLORS[0], borderColor: '#172233', borderWidth: 2, pointRadius: 5, pointHoverRadius: 7 },
                        { label: 'Pico', data: ordered.map(r => point('peak_dbfs', r)), pointStyle: 'triangle',
                          backgroundColor: SERIES_COLORS[1], borderColor: '#172233', borderWidth: 2, pointRadius: 5, pointHoverRadius: 7 }
                    ]
                },
                options: {
                    ...base,
                    interaction: { mode: 'nearest', intersect: true },
                    onClick: (evt, elements, chart) => {
                        if (!elements.length) return;
                        const { datasetIndex, index } = elements[0];
                        this.playRecording(chart.data.datasets[datasetIndex].data[index].rec);
                    },
                    plugins: {
                        ...base.plugins,
                        legend: { labels: { color: '#9db8d4', usePointStyle: true, boxWidth: 8 } },
                        tooltip: {
                            ...base.plugins.tooltip,
                            callbacks: {
                                title: items => this.formatDate(items[0].raw.rec.recorded_at),
                                label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y} dBFS · ${this.formatDuration(ctx.raw.rec.duration_ms)}`,
                                footer: () => 'Clic para escucharla'
                            }
                        }
                    },
                    scales: {
                        x: this.reportTimeAxis(from, to),
                        y: { suggestedMax: 0, grid: { color: 'rgba(157,184,212,0.10)' }, border: { display: false },
                             ticks: { color: '#5a7a98' }, title: { display: true, text: 'dBFS', color: '#5a7a98' } }
                    }
                }
            }));
        },

        async exportReportCsv() {
            const query = this.reportQuery();
            if (!query || !this.reports.deviceId) return;

            try {
                const res = await fetch(`/api/reports/devices/${this.reports.deviceId}/export?${query}`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const match = (res.headers.get('Content-Disposition') || '').match(/filename="(.+)"/);
                const url = URL.createObjectURL(await res.blob());
                const a = document.createElement('a');
                a.href = url;
                a.download = match ? match[1] : 'reporte.csv';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);

                if (res.headers.get('X-Rows-Truncated') === 'true') {
                    this.reports.error = 'Se exportaron las primeras 100.000 lecturas: acota el rango para obtener el resto.';
                }
            } catch (err) {
                this.reports.error = `No se pudo exportar el CSV (${err.message})`;
            }
        },

        // Guardar timezone
        async saveTimezone() {
            try {
                const data = await this.api('/api/settings/timezone', {
                    method: 'PUT',
                    body: JSON.stringify({ timezone: this.timezoneForm.timezone })
                });

                if (data.success) {
                    alert('Zona horaria actualizada correctamente.\n\n' + data.message);
                } else {
                    alert('Error al actualizar la zona horaria');
                }
            } catch (error) {
                console.error('Error guardando timezone:', error);
                alert('Error al guardar la zona horaria: ' + error.message);
            }
        }
    };
}
