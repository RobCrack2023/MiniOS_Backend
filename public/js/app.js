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

        // Ultrasonic Detection Stats
        currentDistance: null,
        currentSpeed: 0,
        isObjectDetected: false,
        detectedAnimal: null,
        gpioTriggered: false,
        detectionStats: {
            total: 0,
            mice: 0,
            cats: 0,
            lastDetection: null,
            lastAnimal: null
        },

        // Control Panel
        showControlPanel: false,
        controlPanelDevice: null,
        panelGpios: [],
        panelDhts: [],
        panelUltrasonics: [],
        panelSensorData: {},
        panelDistance: null,
        panelDetected: false,
        panelAnimal: null,
        panelSpeed: 0,
        panelGpioTriggered: false,
        panelDetectionStats: {
            total: 0,
            mice: 0,
            cats: 0,
            lastDetection: null,
            lastAnimal: null
        },

        // Forms
        newGpio: { pin: '', mode: 'OUTPUT', name: '' },
        newDht: { pin: '', sensor_type: 'DHT11', name: '' },
        newI2c: { sensor_type: 'AHT20', i2c_address: 56, name: '' },
        newUltrasonic: { trig_pin: '', echo_pin: '', name: '' },

        // I2C Scan
        i2cScanResults: [],
        isScanning: false,
        newFirmware: { version: '', description: '', file: null },
        passwordForm: { current: '', new: '' },

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
                    // Actualizar datos ultrasónicos si es el dispositivo seleccionado
                    if (this.selectedDevice && data.mac_address === this.selectedDevice.mac_address) {
                        if (data.payload.ultrasonic && data.payload.ultrasonic.length > 0) {
                            const sensor = data.payload.ultrasonic[0];
                            this.currentDistance = sensor.distance;
                            this.gpioTriggered = sensor.triggered || false;
                            if (sensor.analysis) {
                                const wasDetected = this.isObjectDetected;
                                this.isObjectDetected = sensor.analysis.detected;
                                this.currentSpeed = sensor.analysis.speed || 0;
                                this.detectedAnimal = sensor.analysis.animalType;

                                // Incrementar contador si es nueva detección
                                if (sensor.analysis.detected && !wasDetected) {
                                    this.detectionStats.total++;
                                    this.detectionStats.lastDetection = new Date();
                                    this.detectionStats.lastAnimal = sensor.analysis.animalType;
                                    if (sensor.analysis.animalType === 'mouse') {
                                        this.detectionStats.mice++;
                                    } else if (sensor.analysis.animalType === 'cat') {
                                        this.detectionStats.cats++;
                                    }
                                }
                            }
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

                        // Actualizar Ultrasonic
                        if (data.payload.ultrasonic && data.payload.ultrasonic.length > 0) {
                            const sensor = data.payload.ultrasonic[0];
                            this.panelDistance = sensor.distance;
                            this.panelGpioTriggered = sensor.triggered || false;
                            if (sensor.analysis) {
                                const wasDetected = this.panelDetected;
                                this.panelDetected = sensor.analysis.detected;
                                this.panelSpeed = sensor.analysis.speed || 0;
                                this.panelAnimal = sensor.analysis.animalType;

                                // Incrementar contador si es nueva detección
                                if (sensor.analysis.detected && !wasDetected) {
                                    this.panelDetectionStats.total++;
                                    this.panelDetectionStats.lastDetection = new Date();
                                    this.panelDetectionStats.lastAnimal = sensor.analysis.animalType;
                                    if (sensor.analysis.animalType === 'mouse') {
                                        this.panelDetectionStats.mice++;
                                    } else if (sensor.analysis.animalType === 'cat') {
                                        this.panelDetectionStats.cats++;
                                    }
                                }
                            }
                        }
                    }
                    break;

                case 'ultrasonic_detection':
                    console.log('Detección ultrasónica:', data);
                    // Actualizar UI si es el dispositivo seleccionado
                    if (this.selectedDevice && data.device_id === this.selectedDevice.id) {
                        this.isObjectDetected = data.detection.detected;
                        this.detectedAnimal = data.detection.animalType;
                        this.currentSpeed = data.detection.speed;
                    }
                    break;

                case 'ota_status':
                    console.log('OTA Status:', data);
                    break;

                case 'i2c_scan_result':
                    console.log('Resultado escaneo I2C:', data.devices);
                    this.i2cScanResults = data.devices;
                    this.isScanning = false;
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

            // Reset ultrasonic state
            this.currentDistance = null;
            this.currentSpeed = 0;
            this.isObjectDetected = false;
            this.detectedAnimal = null;

            this.showDeviceModal = true;

            // Reset estadísticas al abrir modal
            this.resetDetectionStats();
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
            this.panelUltrasonics = data.ultrasonic || [];

            // Reset sensor data
            this.panelSensorData = {};
            this.panelDistance = null;
            this.panelDetected = false;
            this.panelAnimal = null;
            this.panelSpeed = 0;

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
            }

            this.showControlPanel = true;

            // Reset estadísticas al abrir panel
            this.resetPanelDetectionStats();
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

            this.isScanning = true;
            this.i2cScanResults = [];

            try {
                await this.api(`/api/devices/${this.selectedDevice.id}/i2c/scan`, {
                    method: 'POST'
                });
                // Los resultados llegarán por WebSocket
            } catch (err) {
                console.error('Error solicitando escaneo I2C:', err);
                this.isScanning = false;
            }
        },

        selectI2cDevice(device) {
            this.newI2c.sensor_type = device.sensor_type !== 'Unknown' ? device.sensor_type : 'AHT20';
            this.newI2c.i2c_address = device.address;
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

        // Helper: icono de animal
        animalIcon(type) {
            if (type === 'mouse') return '🐭';
            if (type === 'cat') return '🐱';
            if (type === 'detecting') return '⏳';
            return '❓';
        },

        // Reset stats
        resetDetectionStats() {
            this.detectionStats = { total: 0, mice: 0, cats: 0, lastDetection: null, lastAnimal: null };
        },

        resetPanelDetectionStats() {
            this.panelDetectionStats = { total: 0, mice: 0, cats: 0, lastDetection: null, lastAnimal: null };
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
            return new Date(dateString).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    };
}
