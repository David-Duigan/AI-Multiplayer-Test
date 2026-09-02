
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('joinGame', (roomCode) => {
        currentRoom = roomCode;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: {},
                gameStarted: false
            };
        }

        const room = rooms[roomCode];
        const playerCount = Object.keys(room.players).length;

        if (playerCount < 2) {
            const playerRole = playerCount === 0 ? 'player1' : 'player2';
            room.players[socket.id] = {
                id: socket.id,
                role: playerRole,
                x: playerRole === 'player1' ? 100 : 700,
                y: 300,
                angle: playerRole === 'player1' ? 0 : Math.PI,
                score: 0,
                color: playerRole === 'player1' ? '#00f0ff' : '#ff0055'
            };

            socket.emit('initPlayer', { role: playerRole, id: socket.id });

            if (Object.keys(room.players).length === 2) {
                room.gameStarted = true;
                io.to(roomCode).emit('startGame', room.players);
            }
        } else {
            socket.emit('roomFull');
        }
    });

    socket.on('playerMove', (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            const player = rooms[currentRoom].players[socket.id];
            player.x = data.x;
            player.y = data.y;
            player.angle = data.angle;

            socket.to(currentRoom).emit('opponentMove', player);
        }
    });

    socket.on('shootOrb', (bulletData) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('opponentShoot', bulletData);
        }
    });

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            io.to(currentRoom).emit('playerLeft');
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));