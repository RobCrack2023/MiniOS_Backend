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
        deviceUltrasonics: [],

        // Ultrasonic / Radar
        currentDistance: null,
        currentSpeed: 0,
        isObjectDetected: false,
        detectedAnimal: null,
        radarCanvas: null,
        radarCtx: null,
        radarAngle: 0,
        radarAnimationId: null,

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
        panelRadarCanvas: null,
        panelRadarCtx: null,
        panelRadarAngle: 0,
        panelRadarAnimationId: null,

        // Forms
        newGpio: { pin: '', mode: 'OUTPUT', name: '' },
        newDht: { pin: '', sensor_type: 'DHT11', name: '' },
        newUltrasonic: { trig_pin: '', echo_pin: '', name: '' },
        newFirmware: { version: '', description: '', file: null },
        passwordForm: { current: '', new: '' },

        // Computed
        get viewTitle() {
            const titles = {
                devices: 'Dispositivos',
                firmware: 'Firmware / OTA',
                settings: 'Configuración'
            };
            return titles[this.currentView] || '';
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
                    }
                    break;

                case 'device_data':
                    this.deviceData[data.mac_address] = {
                        ...this.deviceData[data.mac_address],
                        ...data.payload
                    };
                    // Marcar dispositivo como online y actualizar timestamp
                    const deviceSending = this.devices.find(d => d.mac_address === data.mac_address);
                    if (deviceSending) {
                        deviceSending.is_online = true;
                        deviceSending.last_seen = new Date().toISOString();
                    }
                    // Actualizar datos ultrasónicos si es el dispositivo seleccionado
                    if (this.selectedDevice && data.mac_address === this.selectedDevice.mac_address) {
                        if (data.payload.ultrasonic && data.payload.ultrasonic.length > 0) {
                            const sensor = data.payload.ultrasonic[0];
                            this.currentDistance = sensor.distance;
                            if (sensor.analysis) {
                                this.isObjectDetected = sensor.analysis.detected;
                                this.currentSpeed = sensor.analysis.speed || 0;
                                this.detectedAnimal = sensor.analysis.animalType;
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
                            if (sensor.analysis) {
                                this.panelDetected = sensor.analysis.detected;
                                this.panelSpeed = sensor.analysis.speed || 0;
                                this.panelAnimal = sensor.analysis.animalType;
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
            this.deviceUltrasonics = data.ultrasonic || [];

            // Reset ultrasonic state
            this.currentDistance = null;
            this.currentSpeed = 0;
            this.isObjectDetected = false;
            this.detectedAnimal = null;

            this.showDeviceModal = true;

            // Iniciar radar si hay sensores ultrasónicos
            if (this.deviceUltrasonics.length > 0) {
                this.$nextTick(() => this.initRadar());
            }
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

            // Iniciar radar si hay sensores ultrasónicos
            if (this.panelUltrasonics.length > 0) {
                this.$nextTick(() => this.initPanelRadar());
            }
        },

        closeControlPanel() {
            this.stopPanelRadar();
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

        // Panel Ultrasonic Cone Visualization
        initPanelRadar() {
            const canvas = document.getElementById('controlRadarCanvas');
            if (!canvas) return;

            this.panelRadarCanvas = canvas;
            this.panelRadarCtx = canvas.getContext('2d');
            this.panelRadarAngle = 0;

            this.animatePanelRadar();
        },

        stopPanelRadar() {
            if (this.panelRadarAnimationId) {
                cancelAnimationFrame(this.panelRadarAnimationId);
                this.panelRadarAnimationId = null;
            }
        },

        animatePanelRadar() {
            if (!this.panelRadarCtx || !this.panelRadarCanvas) return;

            const ctx = this.panelRadarCtx;
            const canvas = this.panelRadarCanvas;
            const width = canvas.width;
            const height = canvas.height;
            const padding = 15;

            // Limpiar canvas
            ctx.fillStyle = '#0f3460';
            ctx.fillRect(0, 0, width, height);

            // Configuración del cono
            const sensorX = padding + 25;
            const sensorY = height / 2;
            const coneLength = width - padding * 2 - 35;
            const coneAngle = Math.PI / 6;

            // Obtener configuración del sensor
            const maxDist = this.panelUltrasonics.length > 0 ? (this.panelUltrasonics[0].max_distance || 400) : 400;
            const triggerDist = this.panelUltrasonics.length > 0 ? (this.panelUltrasonics[0].trigger_distance || 50) : 50;

            // Dibujar zona de detección (trigger zone)
            const triggerX = sensorX + (triggerDist / maxDist) * coneLength;
            ctx.fillStyle = 'rgba(231, 76, 60, 0.15)';
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(triggerX, sensorY - Math.tan(coneAngle) * (triggerX - sensorX));
            ctx.lineTo(triggerX, sensorY + Math.tan(coneAngle) * (triggerX - sensorX));
            ctx.closePath();
            ctx.fill();

            // Dibujar cono de detección completo
            const gradient = ctx.createLinearGradient(sensorX, sensorY, sensorX + coneLength, sensorY);
            gradient.addColorStop(0, 'rgba(0, 255, 136, 0.4)');
            gradient.addColorStop(1, 'rgba(0, 255, 136, 0.05)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY - Math.tan(coneAngle) * coneLength);
            ctx.lineTo(sensorX + coneLength, sensorY + Math.tan(coneAngle) * coneLength);
            ctx.closePath();
            ctx.fill();

            // Dibujar líneas del cono
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY - Math.tan(coneAngle) * coneLength);
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY + Math.tan(coneAngle) * coneLength);
            ctx.stroke();

            // Dibujar líneas de distancia (marcas)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.setLineDash([3, 3]);
            for (let i = 1; i <= 4; i++) {
                const markX = sensorX + (coneLength / 4) * i;
                const markDist = Math.round((maxDist / 4) * i);
                ctx.beginPath();
                ctx.moveTo(markX, sensorY - Math.tan(coneAngle) * (markX - sensorX));
                ctx.lineTo(markX, sensorY + Math.tan(coneAngle) * (markX - sensorX));
                ctx.stroke();

                // Etiqueta de distancia
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.font = '9px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${markDist}`, markX, height - 3);
            }
            ctx.setLineDash([]);

            // Dibujar línea de trigger
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(triggerX, sensorY - Math.tan(coneAngle) * (triggerX - sensorX) - 3);
            ctx.lineTo(triggerX, sensorY + Math.tan(coneAngle) * (triggerX - sensorX) + 3);
            ctx.stroke();
            ctx.setLineDash([]);

            // Dibujar sensor (icono)
            ctx.fillStyle = '#00ff88';
            ctx.beginPath();
            ctx.arc(sensorX, sensorY, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#0f3460';
            ctx.beginPath();
            ctx.arc(sensorX, sensorY, 5, 0, Math.PI * 2);
            ctx.fill();

            // Pulso de emisión (animación)
            this.panelRadarAngle += 0.05;
            const pulseRadius = (this.panelRadarAngle % 1) * coneLength;
            if (pulseRadius > 0) {
                ctx.strokeStyle = `rgba(0, 255, 136, ${0.5 - (pulseRadius / coneLength) * 0.5})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(sensorX, sensorY, pulseRadius, -coneAngle, coneAngle);
                ctx.stroke();
            }

            // Dibujar objeto detectado
            if (this.panelDistance !== null && this.panelDistance >= 0) {
                const distRatio = Math.min(this.panelDistance / maxDist, 1);
                const objectX = sensorX + distRatio * coneLength;

                // Determinar color según estado
                let objectColor = '#00ff88';
                if (this.panelDistance <= triggerDist) {
                    objectColor = this.panelDetected ? '#e74c3c' : '#f39c12';
                }

                // Dibujar objeto
                ctx.fillStyle = objectColor;
                ctx.shadowColor = objectColor;
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(objectX, sensorY, 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;

                // Icono según tipo de animal
                if (this.panelDetected && this.panelAnimal) {
                    ctx.fillStyle = '#fff';
                    ctx.font = '12px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    let icon = '?';
                    if (this.panelAnimal === 'mouse') icon = '🐭';
                    else if (this.panelAnimal === 'cat') icon = '🐱';
                    else if (this.panelAnimal === 'detecting') icon = '...';
                    ctx.fillText(icon, objectX, sensorY - 16);
                }

                // Mostrar distancia
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 10px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.round(this.panelDistance)}cm`, objectX, sensorY + 20);
            }

            // Info de velocidad
            if (this.panelSpeed > 0) {
                ctx.fillStyle = this.panelDetected ? '#e74c3c' : '#00ff88';
                ctx.font = 'bold 10px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(`${this.panelSpeed} cm/s`, padding, 12);
            }

            // Continuar animación
            this.panelRadarAnimationId = requestAnimationFrame(() => this.animatePanelRadar());
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

            // Iniciar radar
            this.$nextTick(() => this.initRadar());
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

            // Detener radar si no hay más sensores
            if (this.deviceUltrasonics.length === 0) {
                this.stopRadar();
            }
        },

        // Ultrasonic Cone Visualization
        initRadar() {
            const canvas = document.getElementById('radarCanvas');
            if (!canvas) return;

            this.radarCanvas = canvas;
            this.radarCtx = canvas.getContext('2d');
            this.radarAngle = 0;

            // Iniciar animación
            this.animateRadar();
        },

        stopRadar() {
            if (this.radarAnimationId) {
                cancelAnimationFrame(this.radarAnimationId);
                this.radarAnimationId = null;
            }
        },

        animateRadar() {
            if (!this.radarCtx || !this.radarCanvas) return;

            const ctx = this.radarCtx;
            const canvas = this.radarCanvas;
            const width = canvas.width;
            const height = canvas.height;
            const padding = 20;

            // Limpiar canvas
            ctx.fillStyle = '#0f3460';
            ctx.fillRect(0, 0, width, height);

            // Configuración del cono
            const sensorX = padding + 30;
            const sensorY = height / 2;
            const coneLength = width - padding * 2 - 40;
            const coneAngle = Math.PI / 6; // 30 grados de apertura

            // Obtener configuración del sensor
            const maxDist = this.deviceUltrasonics.length > 0 ? (this.deviceUltrasonics[0].max_distance || 400) : 400;
            const triggerDist = this.deviceUltrasonics.length > 0 ? (this.deviceUltrasonics[0].trigger_distance || 50) : 50;

            // Dibujar zona de detección (trigger zone)
            const triggerX = sensorX + (triggerDist / maxDist) * coneLength;
            ctx.fillStyle = 'rgba(231, 76, 60, 0.15)';
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(triggerX, sensorY - Math.tan(coneAngle) * (triggerX - sensorX));
            ctx.lineTo(triggerX, sensorY + Math.tan(coneAngle) * (triggerX - sensorX));
            ctx.closePath();
            ctx.fill();

            // Dibujar cono de detección completo
            const gradient = ctx.createLinearGradient(sensorX, sensorY, sensorX + coneLength, sensorY);
            gradient.addColorStop(0, 'rgba(0, 255, 136, 0.4)');
            gradient.addColorStop(1, 'rgba(0, 255, 136, 0.05)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY - Math.tan(coneAngle) * coneLength);
            ctx.lineTo(sensorX + coneLength, sensorY + Math.tan(coneAngle) * coneLength);
            ctx.closePath();
            ctx.fill();

            // Dibujar líneas del cono
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY - Math.tan(coneAngle) * coneLength);
            ctx.moveTo(sensorX, sensorY);
            ctx.lineTo(sensorX + coneLength, sensorY + Math.tan(coneAngle) * coneLength);
            ctx.stroke();

            // Dibujar líneas de distancia (marcas)
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.setLineDash([3, 3]);
            for (let i = 1; i <= 4; i++) {
                const markX = sensorX + (coneLength / 4) * i;
                const markDist = Math.round((maxDist / 4) * i);
                ctx.beginPath();
                ctx.moveTo(markX, sensorY - Math.tan(coneAngle) * (markX - sensorX));
                ctx.lineTo(markX, sensorY + Math.tan(coneAngle) * (markX - sensorX));
                ctx.stroke();

                // Etiqueta de distancia
                ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.font = '10px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${markDist}cm`, markX, height - 5);
            }
            ctx.setLineDash([]);

            // Dibujar línea de trigger
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(triggerX, sensorY - Math.tan(coneAngle) * (triggerX - sensorX) - 5);
            ctx.lineTo(triggerX, sensorY + Math.tan(coneAngle) * (triggerX - sensorX) + 5);
            ctx.stroke();
            ctx.setLineDash([]);

            // Etiqueta de trigger
            ctx.fillStyle = '#e74c3c';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${triggerDist}cm`, triggerX, 12);

            // Dibujar sensor (icono)
            ctx.fillStyle = '#00ff88';
            ctx.beginPath();
            ctx.arc(sensorX, sensorY, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#0f3460';
            ctx.beginPath();
            ctx.arc(sensorX, sensorY, 6, 0, Math.PI * 2);
            ctx.fill();

            // Pulso de emisión (animación)
            this.radarAngle += 0.05;
            const pulseRadius = (this.radarAngle % 1) * coneLength;
            if (pulseRadius > 0) {
                ctx.strokeStyle = `rgba(0, 255, 136, ${0.5 - (pulseRadius / coneLength) * 0.5})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(sensorX, sensorY, pulseRadius, -coneAngle, coneAngle);
                ctx.stroke();
            }

            // Dibujar objeto detectado
            if (this.currentDistance !== null && this.currentDistance >= 0) {
                const distRatio = Math.min(this.currentDistance / maxDist, 1);
                const objectX = sensorX + distRatio * coneLength;

                // Determinar color según estado
                let objectColor = '#00ff88'; // Verde: fuera de zona
                if (this.currentDistance <= triggerDist) {
                    objectColor = this.isObjectDetected ? '#e74c3c' : '#f39c12'; // Rojo si detectado/moviendo, naranja si estático
                }

                // Dibujar objeto
                ctx.fillStyle = objectColor;
                ctx.shadowColor = objectColor;
                ctx.shadowBlur = 15;
                ctx.beginPath();
                ctx.arc(objectX, sensorY, 10, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;

                // Icono según tipo de animal
                if (this.isObjectDetected && this.detectedAnimal) {
                    ctx.fillStyle = '#fff';
                    ctx.font = '14px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    let icon = '?';
                    if (this.detectedAnimal === 'mouse') icon = '🐭';
                    else if (this.detectedAnimal === 'cat') icon = '🐱';
                    else if (this.detectedAnimal === 'detecting') icon = '...';
                    ctx.fillText(icon, objectX, sensorY - 20);
                }

                // Mostrar distancia sobre el objeto
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.round(this.currentDistance)} cm`, objectX, sensorY + 25);
            }

            // Info de velocidad
            if (this.currentSpeed > 0) {
                ctx.fillStyle = this.isObjectDetected ? '#e74c3c' : '#00ff88';
                ctx.font = 'bold 11px monospace';
                ctx.textAlign = 'left';
                ctx.fillText(`Vel: ${this.currentSpeed} cm/s`, padding, 15);
            }

            // Continuar animación
            this.radarAnimationId = requestAnimationFrame(() => this.animateRadar());
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
