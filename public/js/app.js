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
        firmwareList: [],

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
        newI2c: { sensor_type: 'AHT20', i2c_address: 56, name: '' },
        newUltrasonic: { trig_pin: '', echo_pin: '', name: '' },

        // I2C Scan
        i2cScanResults: [],
        isScanning: false,
        scanTimeout: null,
        scanMessage: '',

        // History Modal
        showHistoryModal: false,
        historyDevice: null,
        historyConfig: { gpio: [], dht: [], i2c: [], ultrasonic: [] },
        historyRawData: [],
        historyTab: '',
        historyChartInstance: null,
        historyLoading: false,
        historyLimit: 100,
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
        },

        // API Helper
        async api(url, options = {}) {
            const res = await fetch(url, {
                ...options,
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
        connectWebSocket() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws/dashboard`;

            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket conectado');
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                this.handleWebSocketMessage(data);
            };

            this.ws.onclose = () => {
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
            this.selectedDevice = { ...device };
            this.deviceTab = 'info';

            // Cargar configuraciones
            const data = await this.api(`/api/devices/${device.id}`);
            this.deviceGpios = data.gpio || [];
            this.deviceDhts = data.dht || [];
            this.deviceI2cs = data.i2c || [];
            this.deviceUltrasonics = data.ultrasonic || [];

            this.showDeviceModal = true;
        },

        async saveDevice() {
            await this.api(`/api/devices/${this.selectedDevice.id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name: this.selectedDevice.name,
                    description: this.selectedDevice.description
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
        async addI2c() {
            if (!this.newI2c.sensor_type || this.newI2c.i2c_address === '') return;

            await this.api(`/api/devices/${this.selectedDevice.id}/i2c`, {
                method: 'POST',
                body: JSON.stringify(this.newI2c)
            });

            const data = await this.api(`/api/devices/${this.selectedDevice.id}/i2c`);
            this.deviceI2cs = data.i2c;
            this.newI2c = { sensor_type: 'AHT20', i2c_address: 56, name: '' };
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
        // HISTORIAL
        // ============================================

        async openHistoryModal(device) {
            this.historyDevice = { ...device };
            this.historyRawData = [];
            this.historyTab = '';
            this.historyLoading = true;
            this.showHistoryModal = true;

            if (this.historyChartInstance) {
                this.historyChartInstance.destroy();
                this.historyChartInstance = null;
            }

            const [configData, historyData] = await Promise.all([
                this.api(`/api/devices/${device.id}`),
                this.api(`/api/devices/${device.id}/data?limit=${this.historyLimit}`)
            ]);

            this.historyConfig = {
                gpio: configData.gpio || [],
                dht: configData.dht || [],
                i2c: configData.i2c || [],
                ultrasonic: configData.ultrasonic || []
            };
            this.historyRawData = historyData.data || [];
            this.historyLoading = false;

            const types = this.getHistoryTypes();
            if (types.length > 0) {
                this.setHistoryTab(types[0]);
            }
        },

        closeHistoryModal() {
            if (this.historyChartInstance) {
                this.historyChartInstance.destroy();
                this.historyChartInstance = null;
            }
            this.showHistoryModal = false;
            this.historyDevice = null;
            this.historyRawData = [];
        },

        async reloadHistoryData() {
            if (!this.historyDevice) return;
            this.historyLoading = true;
            const data = await this.api(`/api/devices/${this.historyDevice.id}/data?limit=${this.historyLimit}`);
            this.historyRawData = data.data || [];
            this.historyLoading = false;

            const types = this.getHistoryTypes();
            if (this.historyTab && !types.includes(this.historyTab) && types.length > 0) {
                this.historyTab = types[0];
            }
            if (this.historyChartInstance) {
                this.historyChartInstance.destroy();
                this.historyChartInstance = null;
            }
            if (this.historyTab) {
                setTimeout(() => this.renderHistoryChart(), 50);
            }
        },

        getHistoryTypes() {
            const types = [...new Set(this.historyRawData.map(r => r.sensor_type))];
            const order = ['temperature', 'humidity', 'pressure', 'altitude', 'distance', 'gpio', 'analog'];
            return types.sort((a, b) => {
                const ia = order.indexOf(a);
                const ib = order.indexOf(b);
                if (ia === -1 && ib === -1) return 0;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
        },

        setHistoryTab(type) {
            this.historyTab = type;
            if (this.historyChartInstance) {
                this.historyChartInstance.destroy();
                this.historyChartInstance = null;
            }
            setTimeout(() => this.renderHistoryChart(), 50);
        },

        getHistoryTypeName(type) {
            const names = {
                temperature: 'Temperatura',
                humidity: 'Humedad',
                pressure: 'Presión',
                altitude: 'Altitud',
                distance: 'Distancia',
                gpio: 'GPIO',
                analog: 'Analógico'
            };
            return names[type] || type;
        },

        getHistoryUnit(type) {
            const units = {
                temperature: '°C',
                humidity: '%',
                pressure: 'hPa',
                altitude: 'm',
                distance: 'cm'
            };
            return units[type] || '';
        },

        getSensorPinLabel(pin) {
            if (pin == null) return 'Sensor';
            if (this.historyTab === 'temperature' || this.historyTab === 'humidity') {
                const dht = this.historyConfig.dht?.find(d => d.pin == pin);
                if (dht) return dht.name || `DHT pin${pin}`;
                const i2c = this.historyConfig.i2c?.find(i => i.id == pin);
                if (i2c) return i2c.name || `${i2c.sensor_type} [0x${i2c.i2c_address.toString(16).toUpperCase()}]`;
            }
            if (this.historyTab === 'pressure' || this.historyTab === 'altitude') {
                const i2c = this.historyConfig.i2c?.find(i => i.id == pin);
                if (i2c) return i2c.name || i2c.sensor_type;
            }
            if (this.historyTab === 'distance') {
                const us = this.historyConfig.ultrasonic?.find(u => u.trig_pin == pin);
                if (us) return us.name || `HC-SR04 TRIG${pin}`;
            }
            if (this.historyTab === 'gpio' || this.historyTab === 'analog') {
                const gpio = this.historyConfig.gpio?.find(g => g.pin == pin);
                if (gpio) return gpio.name || `GPIO ${pin}`;
                return `GPIO ${pin}`;
            }
            return `Pin ${pin}`;
        },

        renderHistoryChart() {
            const canvas = document.getElementById('historyChart');
            if (!canvas || !this.historyTab) return;

            if (this.historyChartInstance) {
                this.historyChartInstance.destroy();
                this.historyChartInstance = null;
            }

            // Filtrar y ordenar de más antiguo a más reciente
            const typeData = [...this.historyRawData]
                .filter(r => r.sensor_type === this.historyTab)
                .reverse();

            if (typeData.length === 0) return;

            // Agrupar por sensor_pin
            const byPin = {};
            typeData.forEach(r => {
                const key = r.sensor_pin != null ? r.sensor_pin : 'default';
                if (!byPin[key]) byPin[key] = [];
                byPin[key].push(r);
            });

            const colors = ['#2196F3', '#4CAF50', '#FF9800', '#F44336', '#9C27B0', '#00BCD4'];
            const datasets = Object.entries(byPin).map(([pin, records], i) => ({
                label: this.getSensorPinLabel(pin),
                data: records.map(r => r.value),
                borderColor: colors[i % colors.length],
                backgroundColor: colors[i % colors.length] + '22',
                borderWidth: 2,
                pointRadius: records.length > 50 ? 0 : 3,
                tension: 0.3,
                fill: false
            }));

            // Etiquetas del eje X desde el pin con más datos
            const mainPin = Object.keys(byPin).sort((a, b) => byPin[b].length - byPin[a].length)[0];
            const labels = byPin[mainPin].map(r => this.formatDate(r.recorded_at));
            const unit = this.getHistoryUnit(this.historyTab);

            this.historyChartInstance = new Chart(canvas, {
                type: 'line',
                data: { labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: Object.keys(byPin).length > 1 },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(2)}${unit ? ' ' + unit : ''}`
                            }
                        }
                    },
                    scales: {
                        x: { ticks: { maxTicksLimit: 8, maxRotation: 30 } },
                        y: {
                            title: { display: !!unit, text: unit }
                        }
                    }
                }
            });
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
