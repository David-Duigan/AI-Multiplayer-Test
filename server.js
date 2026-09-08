const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const WORDS = ['Banana', 'Airplane', 'Guitar', 'Elephant', 'Pizza', 'House', 'Bicycle', 'Cat', 'Spider', 'Carrot', 'Crown', 'Sun', 'Tree', 'Smartphone', 'Glasses'];
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join_room', ({ roomId, playerName }) => {
    socket.join(roomId);
    currentRoom = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        id: roomId,
        players: [],
        state: 'LOBBY',
        secretWord: '',
        imposterId: null,
        currentTurnIndex: 0,
        votes: {},
        votedPlayers: new Set(),
        voteTimer: null
      };
    }

    const room = rooms[roomId];
    if (room.state === 'LOBBY' && room.players.length < 12) {
      if (!room.players.some(p => p.id === socket.id)) {
        room.players.push({ id: socket.id, name: playerName, isAlive: true });
      }
    }

    io.to(roomId).emit('room_updated', getPublicRoomState(room));
  });

  socket.on('leave_room', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    
    socket.leave(currentRoom);
    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      if (room.voteTimer) clearTimeout(room.voteTimer);
      delete rooms[currentRoom];
    } else {
      io.to(currentRoom).emit('room_updated', getPublicRoomState(room));
    }
    currentRoom = null;
  });

  socket.on('start_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.players.length < 3 || room.state !== 'LOBBY') return;

    room.state = 'STARTING';
    room.secretWord = WORDS[Math.floor(Math.random() * WORDS.length)];
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    room.imposterId = room.players[imposterIndex].id;
    room.currentTurnIndex = 0;

    room.players.forEach(p => {
      const isImposter = (p.id === room.imposterId);
      io.to(p.id).emit('role_assignment', {
        role: isImposter ? 'IMPOSTER' : 'ARTIST',
        word: isImposter ? 'IMPOSTER' : room.secretWord,
        imposterId: room.imposterId
      });
    });

    io.to(currentRoom).emit('pre_game_countdown');

    setTimeout(() => {
      if (!rooms[currentRoom]) return;
      room.state = 'DRAWING';
      io.to(currentRoom).emit('game_started', getPublicRoomState(room));
    }, 3000);
  });

  socket.on('submit_stroke', (strokeData) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'DRAWING') return;

    const activePlayers = room.players.filter(p => p.isAlive);
    const currentPlayer = activePlayers[room.currentTurnIndex];

    if (!currentPlayer || socket.id !== currentPlayer.id) return;

    io.to(currentRoom).emit('draw_stroke', {
      ...strokeData,
      painterName: currentPlayer.name,
      painterId: socket.id
    });

    room.currentTurnIndex++;
    if (room.currentTurnIndex >= activePlayers.length) {
      initiateVotingIntermission(room);
    } else {
      io.to(currentRoom).emit('turn_changed', {
        currentTurnPlayerId: activePlayers[room.currentTurnIndex].id,
        currentTurnName: activePlayers[room.currentTurnIndex].name,
        players: room.players
      });
    }
  });

  socket.on('submit_vote', ({ targetId }) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'VOTING') return;
    
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.isAlive) return;

    recordUserVote(room, socket.id, targetId);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      if (room.voteTimer) clearTimeout(room.voteTimer);
      delete rooms[currentRoom];
    } else {
      io.to(currentRoom).emit('room_updated', getPublicRoomState(room));
    }
  });
});

function initiateVotingIntermission(room) {
  room.state = 'INTERMISSION';
  // 5-second delay so everyone can review the final stroke on the canvas
  io.to(room.id).emit('start_intermission', { delaySeconds: 5 });

  setTimeout(() => {
    if (rooms[room.id]) startVotingPhase(room);
  }, 5000);
}

function startVotingPhase(room) {
  room.state = 'VOTING';
  room.votes = {};
  room.votedPlayers = new Set();

  const alivePlayers = room.players.filter(p => p.isAlive);
  io.to(room.id).emit('start_voting', { alivePlayers, players: room.players });

  if (room.voteTimer) clearTimeout(room.voteTimer);
  room.voteTimer = setTimeout(() => {
    if (!rooms[room.id] || room.state !== 'VOTING') return;
    alivePlayers.forEach(p => {
      if (!room.votedPlayers.has(p.id)) {
        recordUserVote(room, p.id, 'SKIP');
      }
    });
  }, 120000);
}

function recordUserVote(room, voterId, targetId) {
  if (room.votedPlayers.has(voterId)) return;

  room.votedPlayers.add(voterId);
  room.votes[targetId] = (room.votes[targetId] || 0) + 1;

  const alivePlayers = room.players.filter(p => p.isAlive);
  
  io.to(room.id).emit('vote_progress', {
    votedCount: room.votedPlayers.size,
    totalCount: alivePlayers.length
  });

  if (room.votedPlayers.size >= alivePlayers.length) {
    if (room.voteTimer) clearTimeout(room.voteTimer);
    processVotes(room);
  }
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

    io.to(eliminated.id).emit('you_were_eliminated', { imposterId: room.imposterId, imposterName: imposterPlayer.name });

    if (votedOutId === room.imposterId) {
      room.state = 'GAMEOVER';
      io.to(room.id).emit('game_over', {
        winner: 'ARTISTS',
        imposterName: imposterPlayer.name,
        secretWord: room.secretWord,
        message: `The Imposter (${imposterPlayer.name}) was caught!`
      });
    } else {
      const alivePlayers = room.players.filter(p => p.isAlive);
      if (alivePlayers.length <= 2) {
        room.state = 'GAMEOVER';
        io.to(room.id).emit('game_over', {
          winner: 'IMPOSTER',
          imposterName: imposterPlayer.name,
          secretWord: room.secretWord,
          message: `Only 2 players left! Imposter (${imposterPlayer.name}) wins!`
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
    currentTurnName: activePlayers[0].name,
    players: room.players
  });
}

function getPublicRoomState(room) {
  return {
    id: room.id,
    players: room.players,
    state: room.state,
    imposterId: room.imposterId,
    currentTurnPlayerId: room.players.filter(p => p.isAlive)[room.currentTurnIndex]?.id
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));