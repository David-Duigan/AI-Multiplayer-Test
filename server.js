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
        bullets: {},
        powerups: [],
        obstacles: [
            { id: 1, x: 500, y: 350, r: 45, hp: 100, maxHp: 100 },
            { id: 2, x: 1300, y: 350, r: 45, hp: 100, maxHp: 100 },
            { id: 3, x: 500, y: 650, r: 45, hp: 100, maxHp: 100 },
            { id: 4, x: 1300, y: 650, r: 45, hp: 100, maxHp: 100 }
        ],
        lastPowerupSpawn: Date.now()
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
                speedTimer: 0,
                lastProcessedSeq: 0
            };

            socket.emit('initPlayer', { id: socket.id, slot: slot, color: PLAYER_COLORS[slot] });
            io.to(roomCode).emit('roomState', { players: room.players, obstacles: room.obstacles });
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('playerInput', (input) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;

        let speed = p.speedTimer > Date.now() ? 9.5 : 6;
        let nextX = p.x;
        let nextY = p.y;

        if (input.up) nextY -= speed;
        if (input.down) nextY += speed;
        if (input.left) nextX -= speed;
        if (input.right) nextX += speed;

        room.obstacles.forEach(obs => {
            if (obs.hp > 0) {
                const dist = Math.hypot(nextX - obs.x, nextY - obs.y);
                if (dist < obs.r + 20) {
                    const angle = Math.atan2(nextY - obs.y, nextX - obs.x);
                    nextX = obs.x + Math.cos(angle) * (obs.r + 20);
                    nextY = obs.y + Math.sin(angle) * (obs.r + 20);
                }
            }
        });

        p.x = Math.max(30, Math.min(2000, nextX));
        p.y = Math.max(30, Math.min(1200, nextY));
        p.angle = input.angle;
        p.lastProcessedSeq = input.seq;
    });

    socket.on('spawnBullet', (bulletData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;

        room.bullets[bulletData.id] = {
            id: bulletData.id,
            owner: socket.id,
            x: bulletData.x,
            y: bulletData.y,
            vx: bulletData.vx,
            vy: bulletData.vy,
            color: p.color,
            life: 80
        };
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('roomState', { players: rooms[currentRoom].players, obstacles: rooms[currentRoom].obstacles });
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

setInterval(() => {
    Object.keys(rooms).forEach(code => {
        const room = rooms[code];

        if (Date.now() - room.lastPowerupSpawn > 7000 && room.powerups.length < 4) {
            room.lastPowerupSpawn = Date.now();
            const types = ['SHIELD', 'TRIPLE', 'SPEED'];
            room.powerups.push({
                id: Math.random().toString(36).substr(2, 9),
                x: 300 + Math.random() * 1200,
                y: 200 + Math.random() * 600,
                type: types[Math.floor(Math.random() * types.length)]
            });
        }

        for (let i = room.powerups.length - 1; i >= 0; i--) {
            const pow = room.powerups[i];
            Object.values(room.players).forEach(p => {
                if (p.hp > 0 && Math.hypot(p.x - pow.x, p.y - pow.y) < 38) {
                    if (pow.type === 'SHIELD') p.shieldTimer = Date.now() + 6000;
                    if (pow.type === 'TRIPLE') p.tripleTimer = Date.now() + 6000;
                    if (pow.type === 'SPEED') p.speedTimer = Date.now() + 6000;

                    io.to(code).emit('powerupCollected', { type: pow.type, playerId: p.id });
                    room.powerups.splice(i, 1);
                }
            });
        }

        const bulletIds = Object.keys(room.bullets);
        bulletIds.forEach(id => {
            const b = room.bullets[id];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            let hit = false;

            room.obstacles.forEach(obs => {
                if (!hit && obs.hp > 0 && Math.hypot(obs.x - b.x, obs.y - b.y) < obs.r) {
                    hit = true;
                    obs.hp -= 10;
                    io.to(code).emit('impactEvent', { id: b.id, x: b.x, y: b.y, color: '#00f0ff' });

                    if (obs.hp <= 0) {
                        setTimeout(() => { obs.hp = obs.maxHp; }, 10000);
                    }
                }
            });

            Object.values(room.players).forEach(p => {
                if (!hit && p.hp > 0 && p.id !== b.owner) {
                    if (Math.hypot(p.x - b.x, p.y - b.y) < 28) {
                        hit = true;
                        let dmg = (p.shieldTimer > Date.now()) ? 5 : 25;
                        p.hp -= dmg;

                        io.to(code).emit('impactEvent', { id: b.id, x: b.x, y: b.y, color: b.color, victimId: p.id });

                        if (p.hp <= 0) {
                            p.hp = 0;
                            p.deaths++;
                            if (room.players[b.owner]) room.players[b.owner].kills++;

                            io.to(code).emit('playerDestroyed', { victimId: p.id, killerId: b.owner, x: p.x, y: p.y, color: p.color });

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

            if (hit || b.life <= 0) {
                delete room.bullets[id];
            }
        });

        io.to(code).emit('serverState', {
            timestamp: Date.now(),
            players: room.players,
            bullets: room.bullets,
            powerups: room.powerups,
            obstacles: room.obstacles
        });
    });
}, 1000 / 40);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aether Arena Vibe Server running on port ${PORT}`));