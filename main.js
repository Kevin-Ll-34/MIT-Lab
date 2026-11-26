let parsedData = {
    hostname: 'Desconocido',
    version: '15.1',
    interfaces: [],
    routes: [],
    vlans: {},
    dhcpPools: [],
    dynamicRouting: [],
    services: []
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('analyzeBtn').addEventListener('click', processConfig);
    document.getElementById('exportBtn').addEventListener('click', exportToCSV);

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => openTab(btn, btn.dataset.tab));
    });

    document.querySelectorAll('.search-bar').forEach(input => {
        input.addEventListener('keyup', () => filterTable(input.dataset.table, input.value));
    });
});

function openTab(clickedBtn, tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    clickedBtn.classList.add('active');
}

function filterTable(tableId, query) {
    const filter = query.toLowerCase();
    const rows = document.getElementById(tableId).getElementsByTagName('tr');
    for (let i = 1; i < rows.length; i++) {
        const text = rows[i].textContent.toLowerCase();
        rows[i].style.display = text.includes(filter) ? '' : 'none';
    }
}

// Utilidades de Red IPv4
function maskToCidr(mask) {
    if (!mask) return '';
    return mask.split('.').reduce((acc, octet) => acc + (parseInt(octet, 10) >>> 0).toString(2).split('1').length - 1, 0);
}

function ipToLong(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function longToIp(long) {
    return [long >>> 24, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

function calculateSubnetInfo(ip, mask) {
    try {
        const ipL = ipToLong(ip);
        const maskL = ipToLong(mask);
        const netL = (ipL & maskL) >>> 0;
        const bcastL = (netL | (~maskL >>> 0)) >>> 0;
        const cidr = maskToCidr(mask);
        if (cidr >= 31) return `${longToIp(netL)}/${cidr} (Enlace Punto a Punto)`;
        return `Red: ${longToIp(netL)} | Rango: ${longToIp(netL + 1)} - ${longToIp(bcastL - 1)}`;
    } catch (e) {
        return '-';
    }
}

function isIpInSubnet(targetIp, ifaceIp, ifaceMask) {
    try {
        const t = ipToLong(targetIp);
        const i = ipToLong(ifaceIp);
        const m = ipToLong(ifaceMask);
        return ((t & m) >>> 0) === ((i & m) >>> 0);
    } catch (e) {
        return false;
    }
}

function inferSpeedFromPortName(name) {
    const n = name.toLowerCase();
    if (n.startsWith('hundredgig')) return '100 Gbps';
    if (n.startsWith('fortygig')) return '40 Gbps';
    if (n.startsWith('twentyfivegig')) return '25 Gbps';
    if (n.startsWith('tengig')) return '10 Gbps (SFP+)';
    if (n.startsWith('gigabit')) return '1 Gbps (1000 Mbps)';
    if (n.startsWith('fastethernet')) return '100 Mbps';
    if (n.startsWith('port-channel')) return 'Agregado (EtherChannel)';
    if (n.startsWith('vlan')) return 'Interfaz Virtual (SVI)';
    if (n.startsWith('loopback')) return 'Virtual Loopback';
    if (n.startsWith('tunnel')) return 'Túnel GRE/VPN';
    return 'Estándar';
}

function processConfig() {
    const fileInput = document.getElementById('fileInput');
    if (!fileInput.files.length) {
        alert('Por favor selecciona primero el archivo de backup del Cisco Core.');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        parseCiscoIOS(e.target.result);
        renderDashboard();
    };
    reader.readAsText(fileInput.files[0]);
}

function parseCiscoIOS(text) {
    parsedData = {
        hostname: 'No definido',
        version: '15.1',
        interfaces: [],
        routes: [],
        vlans: {},
        dhcpPools: [],
        dynamicRouting: [],
        services: []
    };

    const lines = text.split(/\r?\n/);
    let currentBlock = null;
    let currentObj = null;

    for (let rawLine of lines) {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();

        if (!trimmed || trimmed.startsWith('!')) {
            if (trimmed === '!') {
                currentBlock = null;
                currentObj = null;
            }
            continue;
        }

        if (line.startsWith('hostname ')) {
            parsedData.hostname = line.split(' ')[1];
        } else if (line.startsWith('version ')) {
            parsedData.version = line.split(' ')[1];
        } else if (line.startsWith('ip route ')) {
            parseStaticRoute(trimmed);
        } else if (
            line.startsWith('access-list ') ||
            line.startsWith('ip access-list ') ||
            line.startsWith('ntp ') ||
            line.startsWith('snmp-server ') ||
            line.startsWith('aaa ')
        ) {
            parsedData.services.push(line);
        }

        if (!line.startsWith(' ')) {
            if (line.startsWith('interface ')) {
                currentBlock = 'interface';
                const ifName = line.substring(10).trim();
                currentObj = {
                    name: ifName,
                    description: '',
                    ips: [],
                    vrf: '',
                    shutdown: false,
                    mode: 'L3 / Default',
                    accessVlan: '',
                    trunkAllowed: 'Todas (1-4094)',
                    trunkNative: '1',
                    channelGroup: '',
                    speed: 'Auto (' + inferSpeedFromPortName(ifName) + ')',
                    duplex: 'Auto',
                    helpers: [],
                    hsrp: [],
                    aclIn: '',
                    aclOut: ''
                };
                parsedData.interfaces.push(currentObj);
            } else if (line.startsWith('vlan ') && !line.includes('internal') && !line.includes('configuration')) {
                currentBlock = 'vlan';
                const vlanSpec = line.substring(5).trim();
                currentObj = { id: vlanSpec, name: 'VLAN_' + vlanSpec };
                parsedData.vlans[vlanSpec] = currentObj;
            } else if (line.startsWith('ip dhcp pool ')) {
                currentBlock = 'dhcp';
                currentObj = { name: line.substring(13).trim(), network: '', router: '', dns: '' };
                parsedData.dhcpPools.push(currentObj);
            } else if (line.startsWith('router ')) {
                currentBlock = 'router';
                parsedData.dynamicRouting.push(line);
            } else {
                currentBlock = null;
            }
            continue;
        }

        if (currentBlock === 'interface' && currentObj) {
            if (trimmed.startsWith('description ')) {
                currentObj.description = trimmed.substring(12);
            } else if (trimmed.startsWith('ip address ')) {
                const parts = trimmed.split(/\s+/);
                if (parts[2] !== 'dhcp' && parts[2] !== 'negotiated') {
                    currentObj.ips.push({
                        ip: parts[2],
                        mask: parts[3],
                        secondary: trimmed.includes('secondary')
                    });
                    if (currentObj.mode === 'L3 / Default') currentObj.mode = 'Capa 3 (Routed)';
                }
            } else if (trimmed.startsWith('vrf forwarding ') || trimmed.startsWith('ip vrf forwarding ')) {
                currentObj.vrf = trimmed.split(/\s+/).pop();
            } else if (trimmed === 'shutdown') {
                currentObj.shutdown = true;
            } else if (trimmed === 'no switchport') {
                currentObj.mode = 'Capa 3 (Routed Port)';
            } else if (trimmed.startsWith('switchport mode ')) {
                currentObj.mode = trimmed.substring(16).toUpperCase();
            } else if (trimmed.startsWith('switchport access vlan ')) {
                currentObj.accessVlan = trimmed.split(/\s+/).pop();
            } else if (trimmed.startsWith('switchport trunk allowed vlan ')) {
                const val = trimmed.substring(30);
                if (val.startsWith('add ')) {
                    currentObj.trunkAllowed += ', ' + val.substring(4);
                } else {
                    currentObj.trunkAllowed = val;
                }
            } else if (trimmed.startsWith('switchport trunk native vlan ')) {
                currentObj.trunkNative = trimmed.split(/\s+/).pop();
            } else if (trimmed.startsWith('channel-group ')) {
                const parts = trimmed.split(/\s+/);
                currentObj.channelGroup = `Po${parts[1]} (${parts[3] || ''})`;
            } else if (trimmed.startsWith('speed ')) {
                currentObj.speed = trimmed.substring(6) + ' Mbps (Manual)';
            } else if (trimmed.startsWith('duplex ')) {
                currentObj.duplex = trimmed.substring(7);
            } else if (trimmed.startsWith('ip helper-address ')) {
                currentObj.helpers.push(trimmed.split(/\s+/).pop());
            } else if (trimmed.startsWith('standby ')) {
                currentObj.hsrp.push(trimmed);
            } else if (trimmed.startsWith('ip access-group ')) {
                const parts = trimmed.split(/\s+/);
                if (parts[3] === 'in') currentObj.aclIn = parts[2];
                if (parts[3] === 'out') currentObj.aclOut = parts[2];
            }
        } else if (currentBlock === 'vlan' && currentObj) {
            if (trimmed.startsWith('name ')) {
                currentObj.name = trimmed.substring(5);
            }
        } else if (currentBlock === 'dhcp' && currentObj) {
            if (trimmed.startsWith('network ')) {
                currentObj.network = trimmed.substring(8);
            } else if (trimmed.startsWith('default-router ')) {
                currentObj.router = trimmed.substring(15);
            } else if (trimmed.startsWith('dns-server ')) {
                currentObj.dns = trimmed.substring(11);
            }
        } else if (currentBlock === 'router') {
            parsedData.dynamicRouting.push(line);
        }
    }
}

function parseStaticRoute(line) {
    const parts = line.split(/\s+/);
    let idx = 2;
    let vrf = 'Global';
    if (parts[idx] === 'vrf') {
        vrf = parts[idx + 1];
        idx += 2;
    }
    const dest = parts[idx];
    const mask = parts[idx + 1];
    const nextHop = parts[idx + 2];
    const extra = parts.slice(idx + 3).join(' ');

    parsedData.routes.push({
        vrf,
        dest,
        mask,
        cidr: maskToCidr(mask),
        nextHop,
        extra,
        isDefault: (dest === '0.0.0.0' && mask === '0.0.0.0')
    });
}

function resolveNextHopInterface(nextHop) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(nextHop)) {
        const iface = parsedData.interfaces.find(i => i.name.toLowerCase() === nextHop.toLowerCase());
        return iface ? `${iface.name} (${iface.description || 'Sin descripción'})` : nextHop;
    }
    for (let iface of parsedData.interfaces) {
        for (let ipObj of iface.ips) {
            if (isIpInSubnet(nextHop, ipObj.ip, ipObj.mask)) {
                return `Vía <strong>${iface.name}</strong> ${iface.description ? '→ <em>' + iface.description + '</em>' : ''}`;
            }
        }
    }
    return '<span style="color:#64748b;">Salto recursivo / Indirecto</span>';
}

function renderDashboard() {
    document.getElementById('dashboard').style.display = 'block';
    document.getElementById('exportBtn').style.display = 'inline-block';

    const activePorts = parsedData.interfaces.filter(i => !i.shutdown && !i.name.toLowerCase().startsWith('vlan')).length;
    const l3Interfaces = parsedData.interfaces.filter(i => i.ips.length > 0).length;
    const portChannels = parsedData.interfaces.filter(i => i.name.toLowerCase().startsWith('port-channel')).length;

    document.getElementById('summaryCards').innerHTML = `
        <div class="card"><h3>Hostname / IOS</h3><div class="val">${parsedData.hostname} <small style="font-size:0.9rem;">(v${parsedData.version})</small></div></div>
        <div class="card"><h3>Subredes / Interfaces L3</h3><div class="val">${l3Interfaces}</div></div>
        <div class="card"><h3>Rutas Estáticas</h3><div class="val">${parsedData.routes.length}</div></div>
        <div class="card"><h3>Puertos Físicos/Po Activos</h3><div class="val">${activePorts}</div></div>
        <div class="card"><h3>Port-Channels (LACP)</h3><div class="val">${portChannels}</div></div>
    `;

    const tbodyIps = document.querySelector('#table-ips tbody');
    tbodyIps.innerHTML = '';
    parsedData.interfaces.filter(i => i.ips.length > 0).forEach(iface => {
        iface.ips.forEach(ipObj => {
            const cidr = maskToCidr(ipObj.mask);
            const subnetInfo = calculateSubnetInfo(ipObj.ip, ipObj.mask);
            const extras = [];
            if (iface.vrf) extras.push(`VRF: <strong>${iface.vrf}</strong>`);
            if (iface.helpers.length) extras.push(`DHCP Relay: <code>${iface.helpers.join(', ')}</code>`);
            if (iface.hsrp.length) extras.push('HSRP activo');
            if (ipObj.secondary) extras.push('<span class="tag tag-trunk">IP Secundaria</span>');

            tbodyIps.innerHTML += `
                <tr>
                    <td><strong>${iface.name}</strong></td>
                    <td>${iface.description || '<span style="color:#94a3b8;">Sin descripción</span>'}</td>
                    <td><code>${ipObj.ip}</code></td>
                    <td>${ipObj.mask} (<strong>/${cidr}</strong>)</td>
                    <td><small>${subnetInfo}</small></td>
                    <td>${extras.join('<br>') || '-'}</td>
                    <td>${iface.shutdown ? '<span class="tag tag-down">DOWN (Admin)</span>' : '<span class="tag tag-up">UP</span>'}</td>
                </tr>
            `;
        });
    });

    const tbodyRoutes = document.querySelector('#table-routes tbody');
    tbodyRoutes.innerHTML = '';
    parsedData.routes.forEach(r => {
        const resolved = resolveNextHopInterface(r.nextHop);
        tbodyRoutes.innerHTML += `
            <tr style="${r.isDefault ? 'background-color:#fefce8;' : ''}">
                <td>${r.isDefault ? '<span class="tag tag-trunk">DEFAULT GATEWAY</span>' : '<span class="tag tag-access">Estática (' + r.vrf + ')</span>'}</td>
                <td><code><strong>${r.dest}</strong></code></td>
                <td>${r.mask} (/${r.cidr})</td>
                <td><code>${r.nextHop}</code></td>
                <td>${resolved}</td>
                <td><small>${r.extra || '-'}</small></td>
            </tr>
        `;
    });

    document.getElementById('dynamic-routing').textContent = parsedData.dynamicRouting.length
        ? parsedData.dynamicRouting.join('\n')
        : 'No se configuraron protocolos de enrutamiento dinámico (OSPF, EIGRP, BGP, RIP).';

    const tbodyLinks = document.querySelector('#table-links tbody');
    tbodyLinks.innerHTML = '';
    parsedData.interfaces.filter(i => !i.name.toLowerCase().startsWith('vlan') && !i.name.toLowerCase().startsWith('loopback')).forEach(iface => {
        let modeBadge = `<span class="tag tag-l3">${iface.mode}</span>`;
        let vlanInfo = '-';
        if (iface.mode === 'TRUNK') {
            modeBadge = '<span class="tag tag-trunk">TRUNK</span>';
            vlanInfo = `Permitidas: <strong>${iface.trunkAllowed}</strong><br><small>Nativa: ${iface.trunkNative}</small>`;
        } else if (iface.mode === 'ACCESS') {
            modeBadge = '<span class="tag tag-access">ACCESS</span>';
            const vName = parsedData.vlans[iface.accessVlan]?.name || '';
            vlanInfo = `VLAN <strong>${iface.accessVlan || '1'}</strong> ${vName ? '(' + vName + ')' : ''}`;
        }

        tbodyLinks.innerHTML += `
            <tr>
                <td><strong>${iface.name}</strong></td>
                <td>${iface.description || '<span style="color:#94a3b8;">-</span>'}</td>
                <td>${iface.speed}</td>
                <td>${modeBadge}</td>
                <td>${iface.channelGroup ? '<span class="tag tag-po">' + iface.channelGroup + '</span>' : '-'}</td>
                <td>${vlanInfo}</td>
                <td>${iface.shutdown ? '<span class="tag tag-down">SHUTDOWN</span>' : '<span class="tag tag-up">ACTIVO</span>'}</td>
            </tr>
        `;
    });

    const tbodyVlans = document.querySelector('#table-vlans tbody');
    tbodyVlans.innerHTML = '';
    const allVlanIds = new Set([...Object.keys(parsedData.vlans)]);
    parsedData.interfaces.forEach(i => {
        if (i.name.toLowerCase().startsWith('vlan')) allVlanIds.add(i.name.substring(4));
    });

    Array.from(allVlanIds).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).forEach(vid => {
        const vObj = parsedData.vlans[vid];
        const svi = parsedData.interfaces.find(i => i.name.toLowerCase() === 'vlan' + vid);
        const sviText = svi ? `${svi.name} (${svi.ips.map(x => x.ip + '/' + maskToCidr(x.mask)).join(', ') || 'Sin IP'})` : 'Solo Capa 2';
        tbodyVlans.innerHTML += `
            <tr>
                <td><strong>${vid}</strong></td>
                <td>${vObj ? vObj.name : '<em>Definida por SVI</em>'}</td>
                <td>${sviText}</td>
            </tr>
        `;
    });

    const tbodyDhcp = document.querySelector('#table-dhcp tbody');
    tbodyDhcp.innerHTML = '';
    parsedData.dhcpPools.forEach(p => {
        tbodyDhcp.innerHTML += `
            <tr>
                <td><strong>${p.name}</strong></td>
                <td><code>${p.network}</code></td>
                <td><code>${p.router}</code></td>
                <td><code>${p.dns}</code></td>
            </tr>
        `;
    });

    document.getElementById('services-block').textContent = parsedData.services.length
        ? parsedData.services.join('\n')
        : 'No se encontraron ACLs ni configuraciones de NTP/SNMP/AAA explícitas.';
}

function exportToCSV() {
    let csv = '\uFEFF';
    csv += 'SECCION;INTERFAZ/DESTINO;DESCRIPCION/NEXT-HOP;IP/MASCARA;DETALLE_ENLACE_O_RED;ESTADO\n';

    parsedData.interfaces.forEach(i => {
        const ips = i.ips.map(x => `${x.ip}/${maskToCidr(x.mask)}`).join(' | ') || 'Sin IP';
        const detalle = `${i.mode} | Vel: ${i.speed} | Po: ${i.channelGroup || 'N/A'} | VLANs: ${i.mode === 'TRUNK' ? i.trunkAllowed : (i.accessVlan || 'N/A')}`;
        csv += `INTERFAZ;"${i.name}";"${i.description}";"${ips}";"${detalle}";"${i.shutdown ? 'SHUTDOWN' : 'UP'}"\n`;
    });

    parsedData.routes.forEach(r => {
        const resolved = resolveNextHopInterface(r.nextHop).replace(/<[^>]*>?/gm, '');
        csv += `RUTA_ESTATICA;"${r.dest}/${r.cidr}";"${r.nextHop}";"${r.mask}";"${resolved}";"${r.isDefault ? 'DEFAULT_GATEWAY' : 'ESTATICA'}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Auditoria_Core_${parsedData.hostname}.csv`;
    link.click();
}