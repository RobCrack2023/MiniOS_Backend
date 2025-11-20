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

        // Forms
        newGpio: { pin: '', mode: 'OUTPUT', name: '' },
        newDht: { pin: '', sensor_type: 'DHT11', name: '' },
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
