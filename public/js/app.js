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

        // Radar Animation
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
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const radius = Math.min(centerX, centerY) - 10;

            // Limpiar canvas
            ctx.fillStyle = 'rgba(15, 52, 96, 0.1)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Dibujar círculos de distancia
            ctx.strokeStyle = 'rgba(0, 255, 136, 0.3)';
            ctx.lineWidth = 1;
            for (let i = 1; i <= 4; i++) {
                ctx.beginPath();
                ctx.arc(centerX, centerY, (radius / 4) * i, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Dibujar líneas de cuadrante
            ctx.beginPath();
            ctx.moveTo(centerX, centerY - radius);
            ctx.lineTo(centerX, centerY + radius);
            ctx.moveTo(centerX - radius, centerY);
            ctx.lineTo(centerX + radius, centerY);
            ctx.stroke();

            // Dibujar barrido (sweep)
            const gradient = ctx.createConicalGradient(centerX, centerY, this.radarAngle);
            if (ctx.createConicGradient) {
                const conicGradient = ctx.createConicGradient(this.radarAngle, centerX, centerY);
                conicGradient.addColorStop(0, 'rgba(0, 255, 136, 0.5)');
                conicGradient.addColorStop(0.1, 'rgba(0, 255, 136, 0)');
                conicGradient.addColorStop(1, 'rgba(0, 255, 136, 0)');
                ctx.fillStyle = conicGradient;
                ctx.beginPath();
                ctx.moveTo(centerX, centerY);
                ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
                ctx.fill();
            }

            // Dibujar línea de barrido
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(
                centerX + Math.cos(this.radarAngle) * radius,
                centerY + Math.sin(this.radarAngle) * radius
            );
            ctx.stroke();

            // Dibujar objeto detectado
            if (this.currentDistance && this.deviceUltrasonics.length > 0) {
                const maxDist = this.deviceUltrasonics[0].max_distance || 400;
                const triggerDist = this.deviceUltrasonics[0].trigger_distance || 50;
                const distRatio = Math.min(this.currentDistance / maxDist, 1);
                const objectRadius = distRatio * radius;

                // Punto del objeto
                ctx.fillStyle = this.isObjectDetected ? '#e74c3c' : '#00ff88';
                ctx.beginPath();
                ctx.arc(
                    centerX + Math.cos(this.radarAngle - 0.1) * objectRadius,
                    centerY + Math.sin(this.radarAngle - 0.1) * objectRadius,
                    8,
                    0,
                    Math.PI * 2
                );
                ctx.fill();

                // Círculo de zona de detección
                const triggerRadius = (triggerDist / maxDist) * radius;
                ctx.strokeStyle = 'rgba(231, 76, 60, 0.5)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.arc(centerX, centerY, triggerRadius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Centro
            ctx.fillStyle = '#00ff88';
            ctx.beginPath();
            ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
            ctx.fill();

            // Actualizar ángulo
            this.radarAngle += 0.03;
            if (this.radarAngle > Math.PI * 2) {
                this.radarAngle = 0;
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
