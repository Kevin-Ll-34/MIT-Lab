let devices = [];
let topoState = {
    nodes: [],
    edges: [],
    logicalWidth: 1460,
    logicalHeight: 740,
    panX: 0,
    panY: 0,
    scale: 1,
    draggingNode: null,
    panning: false,
    lastMouse: { x: 0, y: 0 }
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('addBtn').addEventListener('click', addFromInputs);
    document.getElementById('sampleBtn').addEventListener('click', loadSampleTopology);
    document.getElementById('clearBtn').addEventListener('click', clearAllDevices);
    document.getElementById('resetTopoBtn').addEventListener('click', resetTopologyLayout);
    document.getElementById('exportPngBtn').addEventListener('click', exportTopologyPNG);
    document.getElementById('toggleEdgeLabels').addEventListener('change', drawTopology);

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => openTab(btn, btn.dataset.tab));
    });

    document.querySelectorAll('.search-bar').forEach(input => {
        input.addEventListener('keyup', () => filterTable(input.dataset.table, input.value));
    });

    const canvas = document.getElementById('topoCanvas');
    if (canvas) {
        canvas.addEventListener('mousedown', onCanvasMouseDown);
        window.addEventListener('mousemove', onCanvasMouseMove);
        window.addEventListener('mouseup', onCanvasMouseUp);
        canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
    }
});

function openTab(clickedBtn, tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    clickedBtn.classList.add('active');
    if (tabId === 'tab-topology') {
        resizeCanvasForHiDPI();
        drawTopology();
    }
}

function filterTable(tableId, query) {
    const filter = query.toLowerCase();
    const rows = document.getElementById(tableId).getElementsByTagName('tr');
    for (let i = 1; i < rows.length; i++) {
        const text = rows[i].textContent.toLowerCase();
        rows[i].style.display = text.includes(filter) ? '' : 'none';
    }
}

function maskToCidr(mask) {
    if (!mask) return '';
    return mask.split('.').reduce((acc, o) => acc + ((parseInt(o, 10) >>> 0).toString(2).match(/1/g) || []).length, 0);
}

function ipToLong(ip) {
    return ip.split('.').reduce((acc, o) => ((acc << 8) + parseInt(o, 10)) >>> 0, 0);
}

function longToIp(long) {
    return [long >>> 24, (long >>> 16) & 255, (long >>> 8) & 255, long & 255].join('.');
}

function getNetworkCidr(ip, mask) {
    try {
        const cidr = maskToCidr(mask);
        const netLong = (ipToLong(ip) & ipToLong(mask)) >>> 0;
        return `${longToIp(netLong)}/${cidr}`;
    } catch {
        return `${ip}/${mask}`;
    }
}

function isIpInSubnet(targetIp, ifaceIp, ifaceMask) {
    try {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(targetIp)) return false;
        const t = ipToLong(targetIp);
        const i = ipToLong(ifaceIp);
        const m = ipToLong(ifaceMask);
        return ((t & m) >>> 0) === ((i & m) >>> 0);
    } catch {
        return false;
    }
}

function inferSpeed(name) {
    const n = name.toLowerCase();
    if (n.startsWith('hundredgig')) return '100 Gbps';
    if (n.startsWith('fortygig')) return '40 Gbps';
    if (n.startsWith('twentyfivegig')) return '25 Gbps';
    if (n.startsWith('tengig')) return '10 Gbps (SFP+)';
    if (n.startsWith('gigabit')) return '1 Gbps';
    if (n.startsWith('fastethernet')) return '100 Mbps';
    if (n.startsWith('port-channel')) return 'Port-Channel';
    if (n.startsWith('vlan')) return 'SVI (Virtual)';
    if (n.startsWith('loopback')) return 'Loopback';
    if (n.startsWith('tunnel')) return 'Tunnel';
    return 'Estándar';
}

function addFromInputs() {
    const textVal = document.getElementById('configTextarea').value.trim();
    const files = Array.from(document.getElementById('fileInput').files);

    if (!textVal && files.length === 0) {
        alert('Pega el contenido de un backup o selecciona al menos un archivo.');
        return;
    }

    if (textVal) {
        const parsed = parseCiscoIOS(textVal);
        upsertDevice(parsed);
        document.getElementById('configTextarea').value = '';
    }

    if (files.length > 0) {
        let pending = files.length;
        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = e => {
                const parsed = parseCiscoIOS(e.target.result);
                if (parsed.hostname === 'Sin-Hostname') {
                    parsed.hostname = file.name.replace(/\.[^/.]+$/, '');
                }
                upsertDevice(parsed);
                pending--;
                if (pending === 0) {
                    document.getElementById('fileInput').value = '';
                    refreshAll();
                }
            };
            reader.readAsText(file);
        });
    } else {
        refreshAll();
    }
}

function upsertDevice(parsed) {
    const idx = devices.findIndex(d => d.hostname === parsed.hostname);
    if (idx >= 0) devices[idx] = parsed;
    else devices.push(parsed);
}

function clearAllDevices() {
    devices = [];
    document.getElementById('resultsSection').style.display = 'none';
    renderDeviceChips();
}

function removeDevice(hostname) {
    devices = devices.filter(d => d.hostname !== hostname);
    if (devices.length === 0) document.getElementById('resultsSection').style.display = 'none';
    else refreshAll();
}

function renderDeviceChips() {
    const container = document.getElementById('deviceChips');
    container.innerHTML = '';
    devices.forEach(d => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `<span>${d.hostname} (IOS ${d.version})</span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = 'Quitar';
        btn.textContent = '✕';
        btn.addEventListener('click', () => removeDevice(d.hostname));
        chip.appendChild(btn);
        container.appendChild(chip);
    });
}

function parseCiscoIOS(text) {
    const dev = {
        hostname: 'Sin-Hostname',
        version: '15.1',
        interfaces: [],
        staticRoutes: [],
        dynamicNetworks: [],
        routingProtocols: []
    };

    const lines = text.split(/\r?\n/);
    let block = null;
    let currentIf = null;
    let currentProto = null;

    for (const raw of lines) {
        const line = raw.trimEnd();
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('!')) {
            if (trimmed === '!') {
                block = null;
                currentIf = null;
                currentProto = null;
            }
            continue;
        }

        if (line.startsWith('hostname ')) dev.hostname = line.split(/\s+/)[1];
        else if (line.startsWith('version ')) dev.version = line.split(/\s+/)[1];
        else if (line.startsWith('ip route ')) dev.staticRoutes.push(parseStaticRouteLine(trimmed));

        if (!line.startsWith(' ')) {
            if (line.startsWith('interface ')) {
                block = 'interface';
                const name = line.slice(10).trim();
                currentIf = {
                    name,
                    description: '',
                    ips: [],
                    vrf: '',
                    shutdown: false,
                    mode: 'L3',
                    accessVlan: '',
                    trunkAllowed: 'Todas',
                    channelGroup: '',
                    speed: 'Auto (' + inferSpeed(name) + ')',
                    helpers: [],
                    hsrp: []
                };
                dev.interfaces.push(currentIf);
            } else if (line.startsWith('router ')) {
                block = 'router';
                currentProto = line.slice(7).trim();
                if (!dev.routingProtocols.includes(currentProto)) dev.routingProtocols.push(currentProto);
            } else {
                block = null;
            }
            continue;
        }

        if (block === 'interface' && currentIf) {
            if (trimmed.startsWith('description ')) currentIf.description = trimmed.slice(12).trim();
            else if (trimmed.startsWith('ip address ') && !trimmed.includes('dhcp') && !trimmed.includes('negotiated')) {
                const p = trimmed.split(/\s+/);
                currentIf.ips.push({ ip: p[2], mask: p[3], secondary: trimmed.includes('secondary') });
            } else if (trimmed.startsWith('vrf forwarding ') || trimmed.startsWith('ip vrf forwarding ')) {
                currentIf.vrf = trimmed.split(/\s+/).pop();
            } else if (trimmed === 'shutdown') currentIf.shutdown = true;
            else if (trimmed === 'no switchport') currentIf.mode = 'Routed L3';
            else if (trimmed.startsWith('switchport mode ')) currentIf.mode = trimmed.slice(16).trim().toUpperCase();
            else if (trimmed.startsWith('switchport access vlan ')) currentIf.accessVlan = trimmed.split(/\s+/).pop();
            else if (trimmed.startsWith('switchport trunk allowed vlan ')) {
                const v = trimmed.slice(30).trim();
                currentIf.trunkAllowed = v.startsWith('add ') ? `${currentIf.trunkAllowed}, ${v.slice(4)}` : v;
            } else if (trimmed.startsWith('channel-group ')) {
                const p = trimmed.split(/\s+/);
                currentIf.channelGroup = `Po${p[1]}`;
            } else if (trimmed.startsWith('speed ')) currentIf.speed = `${trimmed.slice(6).trim()} Mbps (Manual)`;
            else if (trimmed.startsWith('ip helper-address ')) currentIf.helpers.push(trimmed.split(/\s+/).pop());
            else if (trimmed.startsWith('standby ')) currentIf.hsrp.push(trimmed);
        } else if (block === 'router' && currentProto) {
            if (trimmed.startsWith('network ')) dev.dynamicNetworks.push({ protocol: currentProto, raw: trimmed });
        }
    }

    return dev;
}

function parseStaticRouteLine(line) {
    const parts = line.split(/\s+/);
    let idx = 2;
    let vrf = 'Global';
    if (parts[idx] === 'vrf') {
        vrf = parts[idx + 1];
        idx += 2;
    }
    const dest = parts[idx];
    const mask = parts[idx + 1];
    const nextHop = parts[idx + 2] || '';
    const extra = parts.slice(idx + 3).join(' ');
    return {
        vrf, dest, mask,
        cidr: maskToCidr(mask),
        nextHop, extra,
        isDefault: dest === '0.0.0.0' && mask === '0.0.0.0'
    };
}

function findInterfaceForNextHop(dev, nextHop) {
    if (!nextHop) return null;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(nextHop)) {
        return dev.interfaces.find(i => i.name.toLowerCase() === nextHop.toLowerCase()) || null;
    }
    for (const iface of dev.interfaces) {
        for (const ipObj of iface.ips) {
            if (isIpInSubnet(nextHop, ipObj.ip, ipObj.mask)) return iface;
        }
    }
    return null;
}

function computeNetworkDestinations(dev) {
    const rows = [];
    const defaultRoutes = dev.staticRoutes.filter(r => r.isDefault);
    const specificRoutes = dev.staticRoutes.filter(r => !r.isDefault);

    for (const iface of dev.interfaces) {
        for (const ipObj of iface.ips) {
            const netCidr = getNetworkCidr(ipObj.ip, ipObj.mask);
            const netLong = (ipToLong(ipObj.ip) & ipToLong(ipObj.mask)) >>> 0;
            const cidr = maskToCidr(ipObj.mask);

            const matchingStatic = specificRoutes.filter(r => {
                if (!/^\d+\.\d+\.\d+\.\d+$/.test(r.dest)) return false;
                const rNet = (ipToLong(r.dest) & ipToLong(r.mask)) >>> 0;
                const rCidr = maskToCidr(r.mask);
                return rNet === netLong && rCidr >= cidr;
            });

            const dynMatch = dev.dynamicNetworks.find(d => d.raw.includes(longToIp(netLong)) || d.raw.includes(ipObj.ip));
            const destSummary = [];
            const exitIfSummary = [];

            if (matchingStatic.length > 0) {
                matchingStatic.forEach(r => {
                    const outIf = findInterfaceForNextHop(dev, r.nextHop);
                    destSummary.push(`<span class="tag tag-static">Ruta Específica</span> <code>${r.dest}/${r.cidr}</code> → Next-Hop <code>${r.nextHop}</code> ${r.extra ? '(' + r.extra + ')' : ''}`);
                    if (outIf) exitIfSummary.push(`<strong>${outIf.name}</strong>${outIf.description ? ' — ' + outIf.description : ''}`);
                });
            }

            if (defaultRoutes.length > 0) {
                defaultRoutes.forEach(dr => {
                    const outIf = findInterfaceForNextHop(dev, dr.nextHop);
                    destSummary.push(`<span class="tag tag-default">Default / WAN</span> <code>0.0.0.0/0</code> → Next-Hop <code>${dr.nextHop}</code> ${dr.extra ? '(' + dr.extra + ')' : ''}`);
                    if (outIf) exitIfSummary.push(`<strong>${outIf.name}</strong>${outIf.description ? ' — ' + outIf.description : ''}`);
                });
            }

            if (dynMatch) {
                destSummary.push(`<span class="tag tag-proto">${dynMatch.protocol}</span> Publicada por protocolo dinámico`);
            }

            if (destSummary.length === 0) {
                destSummary.push(`<span class="tag tag-local">Directa / Local</span> Sin ruta estática ni default route`);
            }

            const obs = [];
            if (iface.vrf) obs.push(`VRF: <strong>${iface.vrf}</strong>`);
            if (iface.helpers.length) obs.push(`DHCP Relay: <code>${iface.helpers.join(', ')}</code>`);
            if (iface.hsrp.length) obs.push(`HSRP (${iface.hsrp.length} líneas)`);
            if (iface.shutdown) obs.push(`<span class="tag tag-down">ADMIN DOWN</span>`);

            rows.push({
                device: dev.hostname,
                ifaceName: iface.name,
                ifaceDesc: iface.description,
                network: netCidr,
                ipWithCidr: `${ipObj.ip}/${cidr}`,
                destinationsHtml: destSummary.join('<br>'),
                exitInterfaceHtml: Array.from(new Set(exitIfSummary)).join('<br>') || (iface.description ? `<em>${iface.description}</em>` : '-'),
                obsHtml: obs.join('<br>') || '-'
            });
        }
    }
    return rows;
}

function refreshAll() {
    renderDeviceChips();
    document.getElementById('resultsSection').style.display = 'block';

    const allDestRows = devices.flatMap(d => computeNetworkDestinations(d));
    const totalInterfaces = devices.reduce((acc, d) => acc + d.interfaces.length, 0);
    const totalStatic = devices.reduce((acc, d) => acc + d.staticRoutes.length, 0);
    const totalDefaults = devices.reduce((acc, d) => acc + d.staticRoutes.filter(r => r.isDefault).length, 0);

    document.getElementById('summaryCards').innerHTML = `
        <div class="card"><h3>Equipos Analizados</h3><div class="val">${devices.length}</div></div>
        <div class="card"><h3>Subredes con IP</h3><div class="val">${allDestRows.length}</div></div>
        <div class="card"><h3>Rutas Estáticas</h3><div class="val">${totalStatic}</div></div>
        <div class="card"><h3>Default Routes (0.0.0.0/0)</h3><div class="val">${totalDefaults}</div></div>
        <div class="card"><h3>Interfaces Totales</h3><div class="val">${totalInterfaces}</div></div>
    `;

    document.querySelector('#table-destinations tbody').innerHTML = allDestRows.map(r => `
        <tr>
            <td><strong>${r.device}</strong></td>
            <td><code><strong>${r.network}</strong></code><br><small>${r.ifaceName}${r.ifaceDesc ? ' (' + r.ifaceDesc + ')' : ''}</small></td>
            <td><code>${r.ipWithCidr}</code></td>
            <td>${r.destinationsHtml}</td>
            <td>${r.exitInterfaceHtml}</td>
            <td>${r.obsHtml}</td>
        </tr>
    `).join('');

    const linkRows = [];
    for (const d of devices) {
        for (const iface of d.interfaces) {
            const vlanBadge = iface.mode === 'TRUNK'
                ? `TRUNK (VLANs: ${iface.trunkAllowed})`
                : (iface.accessVlan ? `ACCESS (VLAN ${iface.accessVlan})` : iface.mode);
            const poText = iface.channelGroup ? ` · <strong>${iface.channelGroup}</strong>` : '';
            linkRows.push(`
                <tr>
                    <td><strong>${d.hostname}</strong></td>
                    <td><code>${iface.name}</code></td>
                    <td>${iface.description || '<span style="color:#94a3b8;">-</span>'}</td>
                    <td>${iface.speed}</td>
                    <td>${vlanBadge}${poText}</td>
                    <td>${iface.shutdown ? '<span class="tag tag-down">DOWN</span>' : '<span class="tag tag-up">UP</span>'}</td>
                </tr>
            `);
        }
    }
    document.querySelector('#table-links tbody').innerHTML = linkRows.join('');

    const routeRows = [];
    for (const d of devices) {
        for (const r of d.staticRoutes) {
            const outIf = findInterfaceForNextHop(d, r.nextHop);
            routeRows.push(`
                <tr>
                    <td><strong>${d.hostname}</strong></td>
                    <td>${r.isDefault ? '<span class="tag tag-default">DEFAULT</span>' : '<span class="tag tag-static">ESTÁTICA</span>'}</td>
                    <td><code>${r.dest}/${r.cidr}</code></td>
                    <td>Next-Hop: <code>${r.nextHop}</code> ${r.extra ? '· ' + r.extra : ''}</td>
                    <td>${outIf ? `<strong>${outIf.name}</strong> (${outIf.description || 'Sin desc.'})` : 'No mapeada a interfaz local'}</td>
                </tr>
            `);
        }
        for (const dn of d.dynamicNetworks) {
            routeRows.push(`
                <tr>
                    <td><strong>${d.hostname}</strong></td>
                    <td><span class="tag tag-proto">${dn.protocol}</span></td>
                    <td colspan="2"><code>${dn.raw}</code></td>
                    <td>Protocolo dinámico</td>
                </tr>
            `);
        }
    }
    document.querySelector('#table-routes-detail tbody').innerHTML = routeRows.join('') || '<tr><td colspan="5">No se encontraron rutas configuradas.</td></tr>';

    buildTopologyGraph();
    resizeCanvasForHiDPI();
    drawTopology();
}

function buildTopologyGraph() {
    const nodesMap = new Map();
    const edges = [];

    const addNode = (id, label, sublabel, type) => {
        if (!nodesMap.has(id)) {
            nodesMap.set(id, { id, label, sublabel, type, x: 0, y: 0, r: 22 });
        }
    };

    for (const d of devices) {
        const devId = `dev:${d.hostname}`;
        addNode(devId, d.hostname, `IOS ${d.version}`, 'device');

        for (const iface of d.interfaces) {
            for (const ipObj of iface.ips) {
                const netCidr = getNetworkCidr(ipObj.ip, ipObj.mask);
                const subId = `sub:${d.hostname}:${netCidr}`;
                const subDesc = iface.description || iface.name;
                addNode(subId, netCidr, subDesc, 'subnet');
                edges.push({
                    from: devId,
                    to: subId,
                    label: `${iface.name} (${ipObj.ip}/${maskToCidr(ipObj.mask)})`,
                    style: 'subnet'
                });
            }
        }

        for (const r of d.staticRoutes) {
            const outIf = findInterfaceForNextHop(d, r.nextHop);
            const nhLabel = r.isDefault ? `WAN / GW ${r.nextHop}` : `NH ${r.nextHop}`;
            const nhSub = outIf ? `${outIf.name}${outIf.description ? ' · ' + outIf.description : ''}` : `Destino ${r.dest}/${r.cidr}`;
            const nhId = `nh:${r.nextHop}`;
            addNode(nhId, nhLabel, nhSub, 'nexthop');
            edges.push({
                from: devId,
                to: nhId,
                label: r.isDefault ? '0.0.0.0/0' : `${r.dest}/${r.cidr}`,
                style: r.isDefault ? 'default' : 'route'
            });
        }
    }

    const nodes = Array.from(nodesMap.values());
    const devNodes = nodes.filter(n => n.type === 'device');
    const subNodes = nodes.filter(n => n.type === 'subnet');
    const nhNodes = nodes.filter(n => n.type === 'nexthop');

    const rowSpacing = 96;
    const maxCount = Math.max(devNodes.length, subNodes.length, nhNodes.length, 3);
    const height = Math.max(720, maxCount * rowSpacing + 140);
    const width = 1480;

    topoState.nodes = nodes;
    topoState.edges = edges;
    topoState.logicalWidth = width;
    topoState.logicalHeight = height;

    const layoutColumn = (list, xPos) => {
        if (list.length === 0) return;
        const usableH = height - 140;
        const step = usableH / Math.max(list.length, 1);
        list.forEach((n, idx) => {
            n.x = xPos;
            n.y = 70 + step * (idx + 0.5);
        });
    };

    layoutColumn(subNodes, 250);
    layoutColumn(devNodes, 740);
    layoutColumn(nhNodes, 1220);
}

function resetTopologyLayout() {
    topoState.panX = 0;
    topoState.panY = 0;
    topoState.scale = 1;
    buildTopologyGraph();
    resizeCanvasForHiDPI();
    drawTopology();
}

function resizeCanvasForHiDPI() {
    const canvas = document.getElementById('topoCanvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = topoState.logicalWidth * dpr;
    canvas.height = topoState.logicalHeight * dpr;
    canvas.style.width = `${topoState.logicalWidth}px`;
    canvas.style.height = `${topoState.logicalHeight}px`;
}

function drawTopology() {
    const canvas = document.getElementById('topoCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const showLabels = document.getElementById('toggleEdgeLabels')?.checked ?? true;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, topoState.logicalWidth, topoState.logicalHeight);
    ctx.translate(topoState.panX, topoState.panY);
    ctx.scale(topoState.scale, topoState.scale);

    const nodeById = new Map(topoState.nodes.map(n => [n.id, n]));
    const palette = {
        device: '#0284c7',
        subnet: '#16a34a',
        nexthop: '#d97706'
    };

    for (const e of topoState.edges) {
        const a = nodeById.get(e.from);
        const b = nodeById.get(e.to);
        if (!a || !b) continue;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = e.style === 'default' ? '#d97706' : (e.style === 'route' ? '#7c3aed' : '#94a3b8');
        ctx.lineWidth = e.style === 'default' ? 2.2 : 1.6;
        ctx.stroke();

        if (showLabels && e.label) {
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            ctx.font = '11px Consolas, monospace';
            const w = ctx.measureText(e.label).width + 10;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(mx - w / 2, my - 9, w, 18);
            ctx.strokeStyle = '#cbd5e1';
            ctx.lineWidth = 1;
            ctx.strokeRect(mx - w / 2, my - 9, w, 18);
            ctx.fillStyle = '#0f172a';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(e.label, mx, my);
        }
    }

    for (const n of topoState.nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = palette[n.type] || '#0284c7';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(n.label, n.x, n.y + n.r + 14);

        if (n.sublabel) {
            ctx.fillStyle = '#64748b';
            ctx.font = '11px "Segoe UI", sans-serif';
            ctx.fillText(n.sublabel.slice(0, 36), n.x, n.y + n.r + 28);
        }
    }

    ctx.restore();
}

function toLogicalCoords(clientX, clientY) {
    const canvas = document.getElementById('topoCanvas');
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - topoState.panX) / topoState.scale;
    const y = (clientY - rect.top - topoState.panY) / topoState.scale;
    return { x, y };
}

function onCanvasMouseDown(e) {
    const pt = toLogicalCoords(e.clientX, e.clientY);
    const hit = topoState.nodes.find(n => Math.hypot(n.x - pt.x, n.y - pt.y) <= n.r + 4);
    if (hit) {
        topoState.draggingNode = hit;
    } else {
        topoState.panning = true;
    }
    topoState.lastMouse = { x: e.clientX, y: e.clientY };
}

function onCanvasMouseMove(e) {
    if (topoState.draggingNode) {
        const pt = toLogicalCoords(e.clientX, e.clientY);
        topoState.draggingNode.x = pt.x;
        topoState.draggingNode.y = pt.y;
        drawTopology();
    } else if (topoState.panning) {
        topoState.panX += e.clientX - topoState.lastMouse.x;
        topoState.panY += e.clientY - topoState.lastMouse.y;
        topoState.lastMouse = { x: e.clientX, y: e.clientY };
        drawTopology();
    }
}

function onCanvasMouseUp() {
    topoState.draggingNode = null;
    topoState.panning = false;
}

function onCanvasWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    topoState.scale = Math.min(2.5, Math.max(0.4, topoState.scale * factor));
    drawTopology();
}

function exportTopologyPNG() {
    const canvas = document.getElementById('topoCanvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = 'topologia_cisco_ios.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
}

function loadSampleTopology() {
    const sample = `
hostname CORE-SW-01
version 15.1
!
interface GigabitEthernet0/0
 description Enlace hacia ISP / WAN Principal
 ip address 203.0.113.2 255.255.255.252
 no shutdown
!
interface GigabitEthernet0/1
 description Troncal hacia Distribucion
 switchport trunk encapsulation dot1q
 switchport trunk allowed vlan 10,20,30
 switchport mode trunk
 channel-group 1 mode active
 no shutdown
!
interface Vlan10
 description VLAN Usuarios Corporativos
 ip address 10.10.10.1 255.255.255.0
 ip helper-address 10.10.20.5
!
interface Vlan20
 description VLAN Servidores
 ip address 10.10.20.1 255.255.255.0
!
router ospf 1
 network 10.10.10.0 0.0.0.255 area 0
 network 10.10.20.0 0.0.0.255 area 0
!
ip route 0.0.0.0 0.0.0.0 203.0.113.1
ip route 192.168.50.0 255.255.255.0 10.10.20.254
!
end
`.trim();

    devices = [parseCiscoIOS(sample)];
    refreshAll();
}