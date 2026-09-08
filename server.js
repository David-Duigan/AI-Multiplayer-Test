const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const PLAYER_COLORS = ['#00f0ff', '#ff0055', '#ffcc00', '#00ff66'];
const SPAWNS = [
    { x: 150, y: 150 },
    { x: 1770, y: 930 },
    { x: 1770, y: 150 },
    { x: 150, y: 930 }
];

const rooms = {};

function createRoom(roomCode) {
    return {
        id: roomCode,
        players: {},
        bullets: [],
        nextBulletId: 1
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
                color: PLAYER_COLORS[slot]
            };

            socket.emit('initPlayer', { id: socket.id, slot: slot, color: PLAYER_COLORS[slot] });
            io.to(roomCode).emit('roomState', { players: room.players });
        } else {
            socket.emit('roomFull');
        }
    });

    // Client sends predicted position
    socket.on('playerTransform', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const p = rooms[currentRoom].players[socket.id];
        if (p && p.hp > 0) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
        }
    });

    // Client requests bullet spawn (Server Authenticated)
    socket.on('requestShoot', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const p = room.players[socket.id];
        if (!p || p.hp <= 0) return;

        const speed = 18;
        room.bullets.push({
            id: room.nextBulletId++,
            owner: socket.id,
            x: p.x + Math.cos(data.angle) * 30,
            y: p.y + Math.sin(data.angle) * 30,
            vx: Math.cos(data.angle) * speed,
            vy: Math.sin(data.angle) * speed,
            color: p.color,
            life: 90
        });
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

// Server Loop: 40 FPS Bullet Physics & Hit Detection
setInterval(() => {
    Object.keys(rooms).forEach(code => {
        const room = rooms[code];

        // Update Bullets
        for (let i = room.bullets.length - 1; i >= 0; i--) {
            const b = room.bullets[i];
            b.x += b.vx;
            b.y += b.vy;
            b.life--;

            let hit = false;

            // Server Hit Check against all living targets
            Object.values(room.players).forEach(p => {
                if (!hit && p.hp > 0 && p.id !== b.owner) {
                    const dist = Math.hypot(p.x - b.x, p.y - b.y);
                    if (dist < 26) {
                        hit = true;
                        p.hp -= 25;

                        if (p.hp <= 0) {
                            p.hp = 0;
                            p.deaths++;
                            if (room.players[b.owner]) {
                                room.players[b.owner].kills++;
                            }

                            // Delayed Respawn
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
                            }, 3000);
                        }
                    }
                }
            });

            if (hit || b.life <= 0 || b.x < -100 || b.x > 3000 || b.y < -100 || b.y > 3000) {
                room.bullets.splice(i, 1);
            }
        }

        // Broadcast State
        io.to(code).emit('serverState', {
            players: room.players,
            bullets: room.bullets
        });
    });
}, 1000 / 40);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aether Arena Server running on port ${PORT}`));