const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const PLAYER_COLORS = ['#00f0ff', '#ff0055', '#ffcc00', '#00ff66'];
const PLAYER_SPAWNS = [
    { x: 100, y: 100 },
    { x: 900, y: 600 },
    { x: 900, y: 100 },
    { x: 100, y: 600 }
];

const rooms = {};

function createRoom(roomCode) {
    return {
        id: roomCode,
        players: {},
        bullets: [],
        powerups: [],
        hazards: [
            { x: 500, y: 350, r: 40, angle: 0, speed: 0.02 }
        ],
        lastPowerup: Date.now()
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
            const spawn = PLAYER_SPAWNS[slot];
            
            room.players[socket.id] = {
                id: socket.id,
                slot: slot,
                x: spawn.x,
                y: spawn.y,
                hp: 100,
                kills: 0,
                deaths: 0,
                color: PLAYER_COLORS[slot],
                shield: 0,
                tripleShot: 0
            };

            socket.emit('initPlayer', { id: socket.id, slot: slot, color: PLAYER_COLORS[slot] });
            io.to(roomCode).emit('roomState', room);
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('playerInput', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const player = rooms[currentRoom].players[socket.id];
        if (!player || player.hp <= 0) return;

        player.x = data.x;
        player.y = data.y;
    });

    socket.on('shoot', (shootData) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const player = room.players[socket.id];
        if (!player || player.hp <= 0) return;

        if (player.tripleShot > Date.now()) {
            [-0.2, 0, 0.2].forEach(angleOffset => {
                const finalAngle = shootData.angle + angleOffset;
                room.bullets.push({
                    id: Math.random(),
                    owner: socket.id,
                    x: player.x,
                    y: player.y,
                    vx: Math.cos(finalAngle) * 10,
                    vy: Math.sin(finalAngle) * 10,
                    color: player.color,
                    life: 100
                });
            });
        } else {
            room.bullets.push({
                id: Math.random(),
                owner: socket.id,
                x: player.x,
                y: player.y,
                vx: Math.cos(shootData.angle) * 10,
                vy: Math.sin(shootData.angle) * 10,
                color: player.color,
                life: 100
            });
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('roomState', rooms[currentRoom]);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

// Server Loop for Physics & Sync
setInterval(() => {
    Object.keys(rooms).forEach(roomCode => {
        const room = rooms[roomCode];

        // Update hazard angles
        room.hazards.forEach(h => h.angle += h.speed);

        // Spawn powerups
        if (Date.now() - room.lastPowerup > 10000 && room.powerups.length < 3) {
            room.lastPowerup = Date.now();
            const types = ['SHIELD', 'TRIPLE', 'HEAL'];
            room.powerups.push({
                id: Math.random(),
                x: 150 + Math.random() * 700,
                y: 100 + Math.random() * 500,
                type: types[Math.floor(Math.random() * types.length)]
            });
        }

        // Update Bullets & Collisions
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            let b = room.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            // Wall Bounce / Destroy
            if (b.x < 10 || b.x > 990 || b.y < 10 || b.y > 690 || b.life <= 0) {
                room.bullets.splice(i, 1);
                continue;
            }

            // Hit Players
            Object.keys(room.players).forEach(pId => {
                let p = room.players[pId];
                if (p.hp > 0 && b.owner !== pId) {
                    let dist = Math.hypot(p.x - b.x, p.y - b.y);
                    if (dist < 20) {
                        let damage = 20;
                        if (p.shield > Date.now()) {
                            damage = 5;
                        }
                        p.hp -= damage;
                        room.bullets.splice(i, 1);

                        if (p.hp <= 0) {
                            p.deaths++;
                            if (room.players[b.owner]) room.players[b.owner].kills++;
                            
                            // Respawn delayed
                            setTimeout(() => {
                                const spawn = PLAYER_SPAWNS[p.slot || 0];
                                p.hp = 100;
                                p.x = spawn.x;
                                p.y = spawn.y;
                            }, 3000);
                        }
                    }
                }
            });
        }

        // Powerup Pickup
        for (let i = room.powerups.length - 1; i >= 0; i--) {
            let pow = room.powerups[i];
            Object.keys(room.players).forEach(pId => {
                let p = room.players[pId];
                if (p.hp > 0 && Math.hypot(p.x - pow.x, p.y - pow.y) < 25) {
                    if (pow.type === 'SHIELD') p.shield = Date.now() + 6000;
                    if (pow.type === 'TRIPLE') p.tripleShot = Date.now() + 6000;
                    if (pow.type === 'HEAL') p.hp = Math.min(100, p.hp + 40);
                    room.powerups.splice(i, 1);
                }
            });
        }

        io.to(roomCode).emit('tick', {
            players: room.players,
            bullets: room.bullets,
            powerups: room.powerups,
            hazards: room.hazards
        });
    });
}, 1000 / 30); // 30 Ticks per second

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aether Arena running on port ${PORT}`));