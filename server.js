const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const PLAYER_COLORS = ['#00f0ff', '#ff0055', '#ffcc00', '#00ff66'];
const PLAYER_SPAWNS = [
    { x: 150, y: 150 },
    { x: 1770, y: 930 },
    { x: 1770, y: 150 },
    { x: 150, y: 930 }
];

const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('joinGame', (roomCode) => {
        currentRoom = roomCode;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                id: roomCode,
                players: {},
                powerups: []
            };
        }

        const room = rooms[roomCode];
        const playerIds = Object.keys(room.players);

        if (playerIds.length < 4) {
            const slot = playerIds.length;
            const spawn = PLAYER_SPAWNS[slot];

            const newPlayer = {
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

            room.players[socket.id] = newPlayer;

            // Notify joining player
            socket.emit('initPlayer', { id: socket.id, slot: slot, player: newPlayer });
            
            // Sync everyone in room
            io.to(roomCode).emit('playerJoined', { players: room.players });
        } else {
            socket.emit('roomFull');
        }
    });

    // Client-authoritative sync
    socket.on('updateState', (data) => {
        if (!currentRoom || !rooms[currentRoom]) return;
        const p = rooms[currentRoom].players[socket.id];
        if (p) {
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            p.hp = data.hp;
            p.kills = data.kills;
            p.deaths = data.deaths;
        }
        socket.to(currentRoom).emit('opponentState', { id: socket.id, ...data });
    });

    socket.on('spawnBullet', (bulletData) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('bulletSpawned', bulletData);
        }
    });

    socket.on('playerHit', (hitData) => {
        if (currentRoom) {
            io.to(currentRoom).emit('applyDamage', hitData);
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('playerLeft', socket.id);
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aether Arena Overdrive active on port ${PORT}`));