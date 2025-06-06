// Express.js server for local development
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { db } = require('./helpers/db');
const { handle: batchPostHandler } = require('./endpoints/youtube/batch_POST');

const app = express();
app.use(cors());
app.use(express.json());

// Example: Ported batch_POST endpoint
app.post('/api/youtube/batch', async (req, res) => {
  try {
    const result = await batchPostHandler(req);
    res.status(200).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
