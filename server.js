const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const PLAYER_COLORS = ['#00f0ff', '#ff0055', '#ffcc00', '#00ff66'];
const SPAWNS = [
    { x: 200, y: 200 },
    { x: 1600, y: 800 },
    { x: 1600, y: 200 },
    { x: 200, y: 800 }
];

const rooms = {};

function createRoom(roomCode) {
    return {
        id: roomCode,
        players: {},
        bullets: [],
        powerups: [],
        nextBulletId: 1,
        lastPowerupSpawn: Date.now(),
        hazardAngle: 0
    };
}

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('joinGame', (roomCode) => {
        currentRoom = roomCode;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = createRoom(roomCode);
        }

        const room = rooms[roomCode];
        const playerIds = Object.keys(room.players);

        if (playerIds.length < 4) {
            const slot = playerIds.length;
            const spawn = SPAWNS[slot] || SPAWNS[0];

            room.players[socket.id] = {
                id: socket.id,
                slot: slot,
                x: spawn.x,
                y: spawn.y,
                angle: 0,
                hp: 100,
                kills: 0,
                deaths: 0,
                color: PLAYER_COLORS[slot],
                shieldTimer: 0,
                tripleTimer: 0,
                speedTimer: 0
            };

            socket.emit('initPlayer', { id: socket.id, slot: slot, color: PLAYER_COLORS[slot] });
            io.to(roomCode).emit('roomState', { players: room.players });
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('playerTransform', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const p = rooms[currentRoom].players[socket.id];
        if (p && p.hp > 0) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
    });

    // Spawn bullets using CLIENT LOCAL origin coordinates
    socket.on('requestShoot', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;

        const speed = 20;

        if (data.isTriple || p.tripleTimer > Date.now()) {
            [-0.2, 0, 0.2].forEach(offset => {
                const finalAngle = data.angle + offset;
                room.bullets.push({
                    id: room.nextBulletId++,
                    owner: socket.id,
                    x: data.originX + Math.cos(finalAngle) * 30,
                    y: data.originY + Math.sin(finalAngle) * 30,
                    vx: Math.cos(finalAngle) * speed,
                    vy: Math.sin(finalAngle) * speed,
                    color: p.color,
                    life: 80
                });
            });
        } else {
            room.bullets.push({
                id: room.nextBulletId++,
                owner: socket.id,
                x: data.originX + Math.cos(data.angle) * 30,
                y: data.originY + Math.sin(data.angle) * 30,
                vx: Math.cos(data.angle) * speed,
                vy: Math.sin(data.angle) * speed,
                color: p.color,
                life: 80
            });
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('roomState', { players: rooms[currentRoom].players });
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

// Server Game Loop (40 Ticks/Sec)
setInterval(() => {
    Object.keys(rooms).forEach(code => {
        const room = rooms[code];

        // Update Central Hazard
        room.hazardAngle += 0.02;

        // Spawn Power-Ups
        if (Date.now() - room.lastPowerupSpawn > 7000 && room.powerups.length < 4) {
            room.lastPowerupSpawn = Date.now();
            const types = ['SHIELD', 'TRIPLE', 'SPEED'];
            room.powerups.push({
                id: Math.random(),
                x: 300 + Math.random() * 1200,
                y: 200 + Math.random() * 600,
                type: types[Math.floor(Math.random() * types.length)]
            });
        }

        // Check Powerup Pickups
        for (let i = room.powerups.length - 1; i >= 0; i--) {
            const pow = room.powerups[i];
            Object.values(room.players).forEach(p => {
                if (p.hp > 0 && Math.hypot(p.x - pow.x, p.y - pow.y) < 35) {
                    if (pow.type === 'SHIELD') p.shieldTimer = Date.now() + 6000;
                    if (pow.type === 'TRIPLE') p.tripleTimer = Date.now() + 6000;
                    if (pow.type === 'SPEED') p.speedTimer = Date.now() + 6000;

                    io.to(code).emit('powerupCollected', { playerId: p.id, type: pow.type });
                    room.powerups.splice(i, 1);
                }
            });
        }

        // Bullets Collision & Physics
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            let hit = false;

            Object.values(room.players).forEach(p => {
                if (!hit && p.hp > 0 && p.id !== b.owner) {
                    const dist = Math.hypot(p.x - b.x, p.y - b.y);
                    if (dist < 26) {
                        hit = true;

                        // Shield Mitigates Damage
                        let dmg = 25;
                        if (p.shieldTimer > Date.now()) dmg = 5;

                        p.hp -= dmg;

                        io.to(code).emit('impactEvent', { x: b.x, y: b.y, color: b.color });

                        if (p.hp <= 0) {
                            p.hp = 0;
                            p.deaths++;
                            if (room.players[b.owner]) room.players[b.owner].kills++;

                            const targetId = p.id;
                            const slot = p.slot;
                            setTimeout(() => {
                                if (room.players[targetId]) {
                                    const spawn = SPAWNS[slot] || SPAWNS[0];
                                    room.players[targetId].hp = 100;
                                    room.players[targetId].x = spawn.x;
                                    room.players[targetId].y = spawn.y;
                                    io.to(code).emit('respawnPlayer', { id: targetId, x: spawn.x, y: spawn.y });
                                }
                            }, 2500);
                        }
                    }
                }
            });

            if (hit || b.life <= 0 || b.x < -100 || b.x > 3000 || b.y < -100 || b.y > 3000) {
                room.bullets.splice(i, 1);
            }
        }

        // Sync state to room
        io.to(code).emit('serverState', {
            players: room.players,
            bullets: room.bullets,
            powerups: room.powerups,
            hazardAngle: room.hazardAngle
        });
    });
}, 1000 / 40);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aether Arena Server running on port ${PORT}`));