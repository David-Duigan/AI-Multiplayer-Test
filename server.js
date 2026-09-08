const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

const WORDS = ['Banana', 'Airplane', 'Guitar', 'Elephant', 'Pizza', 'House', 'Bicycle', 'Cat', 'Spider', 'Carrot', 'Crown', 'Sun', 'Tree', 'Smartphone', 'Glasses'];

// Room State Management
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join_room', ({ roomId, playerName }) => {
    socket.join(roomId);
    currentRoom = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [], // { id, name, isAlive }
        state: 'LOBBY', // LOBBY, DRAWING, VOTING, GAMEOVER
        secretWord: '',
        imposterId: null,
        currentTurnIndex: 0,
        votes: {}, // voterId -> targetPlayerId / 'SKIP'
        votedPlayers: new Set()
      };
    }

    const room = rooms[roomId];
    
    // Prevent duplicate joins or mid-game join as active player
    if (room.state === 'LOBBY' && room.players.length < 8) {
      room.players.push({ id: socket.id, name: playerName, isAlive: true });
    }

    io.to(roomId).emit('room_updated', room);
  });

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.players.length < 3 || room.state !== 'LOBBY') return;

    room.state = 'DRAWING';
    room.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];
    
    // Assign Imposter
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    room.imposterId = room.players[imposterIndex].id;
    room.currentTurnIndex = 0;

    // Send private roles to individual sockets
    room.players.forEach(p => {
      const isImposter = (p.id === room.imposterId);
      io.to(p.id).emit('role_assignment', {
        role: isImposter ? 'IMPOSTER' : 'ARTIST',
        word: isImposter ? 'IMPOSTER' : room.secretWord
      });
    });

    io.to(currentRoom).emit('game_started', getPublicRoomState(room));
  });

  socket.on('submit_stroke', (strokeData) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'DRAWING') return;

    const activePlayers = room.players.filter(p => p.isAlive);
    const currentPlayer = activePlayers[room.currentTurnIndex];

    if (socket.id !== currentPlayer.id) return; // Not their turn

    // Broadcast stroke to all players in the room
    io.to(currentRoom).emit('draw_stroke', strokeData);

    // Advance turn
    room.currentTurnIndex++;
    if (room.currentTurnIndex >= activePlayers.length) {
      startVotingPhase(room);
    } else {
      io.to(currentRoom).emit('turn_changed', {
        currentTurnPlayerId: activePlayers[room.currentTurnIndex].id,
        currentTurnName: activePlayers[room.currentTurnIndex].name
      });
    }
  });

  socket.on('submit_vote', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;
    if (room.votedPlayers.has(socket.id)) return;

    room.votedPlayers.add(socket.id);
    room.votes[targetId] = (room.votes[targetId] || 0) + 1;

    const alivePlayers = room.players.filter(p => p.isAlive);
    
    // Broadcast progress
    io.to(currentRoom).emit('vote_progress', {
      votedCount: room.votedPlayers.size,
      totalCount: alivePlayers.length
    });

    // Check if everyone has voted
    if (room.votedPlayers.size >= alivePlayers.length) {
      processVotes(room);
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[currentRoom];
    } else {
      io.to(currentRoom).emit('room_updated', getPublicRoomState(room));
    }
  });
});

function startVotingPhase(room) {
  room.state = 'VOTING';
  room.votes = {};
  room.votedPlayers = new Set();

  io.to(room.id).emit('start_voting', {
    alivePlayers: room.players.filter(p => p.isAlive)
  });
}

function processVotes(room) {
  let maxVotes = 0;
  let votedOutId = null;
  let isTie = false;

  for (const [target, count] of Object.entries(room.votes)) {
    if (count > maxVotes) {
      maxVotes = count;
      votedOutId = target;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  }

  const imposterPlayer = room.players.find(p => p.id === room.imposterId);

  if (isTie || votedOutId === 'SKIP' || !votedOutId) {
    io.to(room.id).emit('vote_result', {
      outcome: 'SKIP',
      message: 'Voting resulted in a skip or tie! No one was eliminated.'
    });
    nextRound(room);
  } else {
    const eliminated = room.players.find(p => p.id === votedOutId);
    eliminated.isAlive = false;

    if (votedOutId === room.imposterId) {
      // Imposter Eliminated -> Artists Win
      room.state = 'GAMEOVER';
      io.to(room.id).emit('game_over', {
        winner: 'ARTISTS',
        message: `The Imposter (${imposterPlayer.name}) was caught! Artists win!`
      });
    } else {
      // Innocent Eliminated
      const alivePlayers = room.players.filter(p => p.isAlive);
      if (alivePlayers.length <= 2) {
        // Imposter Wins
        room.state = 'GAMEOVER';
        io.to(room.id).emit('game_over', {
          winner: 'IMPOSTER',
          message: `Only 2 players left! Imposter (${imposterPlayer.name}) wins! Secret word was: ${room.secretWord}`
        });
      } else {
        io.to(room.id).emit('vote_result', {
          outcome: 'ELIMINATED',
          message: `${eliminated.name} was NOT the imposter!`
        });
        nextRound(room);
      }
    }
  }
}

function nextRound(room) {
  room.state = 'DRAWING';
  room.currentTurnIndex = 0;
  const activePlayers = room.players.filter(p => p.isAlive);

  io.to(room.id).emit('next_round', {
    currentTurnPlayerId: activePlayers[0].id,
    currentTurnName: activePlayers[0].name
  });
}

function getPublicRoomState(room) {
  return {
    id: room.id,
    players: room.players,
    state: room.state,
    currentTurnPlayerId: room.players.filter(p => p.isAlive)[room.currentTurnIndex]?.id
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server online on port ${PORT}`));