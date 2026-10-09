require('dotenv').config();

const express = require('express');
const axios = require('axios');
const session = require('express-session');
const { createLimiter } = require('./runtime');
const { AgenticLoop } = require('./ai');
const { validateVehicle } = require('./agentic_loop_helpers');

const enqueueAI = createLimiter(Number(process.env.RESEARCH_CONCURRENCY || 2));

const app = express();
const { PORT, SESSION_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK } = process.env;

app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(express.json());

// Simple home page
app.get('/', (req, res) => {
  res.send(`
    <h1>OAuth Mini Demo</h1>
    <p>${req.session.user ? `Logged in as <b>${req.session.user.login}</b>` : 'Not logged in'}</p>
    <ul>
      <li><a href="/login">Log in with GitHub</a></li>
      <li><a href="/api/hello">GET /api/hello (protected)</a></li>
      <li><a href="/logout">Logout</a></li>
    </ul>
  `);
});

// Step 1: Redirect user to GitHub
app.get('/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK,
    scope: 'read:user user:email'
  });

  //res.redirect('https://google.com')
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// Step 2: GitHub redirects back here with ?code=...
app.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) return res.status(400).send('Missing code');

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK
      },
      { headers: { Accept: 'application/json' } }
    );

    const access_token = tokenRes.data.access_token;

    if (!access_token) return res.status(401).send('Token exchange failed');

    // Fetch user profile
    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }
    });

    // Save minimal user info in session
    req.session.user = { login: userRes.data.login, id: userRes.data.id };
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth error. Check terminal for details.');
  }
});

// Guard for protected routes
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Unauthorized. Visit /login first.' });
}

// Protected API
app.get('/api/hello', requireAuth, (req, res) => {
  res.json({ message: `Hello, ${req.session.user.login}! 🎉` });
});

app.post('/api/hello', async (req, res, next) => {
  try {
    const vehicle = req.body?.vehicle || req.body;

    if (!vehicle || typeof vehicle !== 'object' || Array.isArray(vehicle)
      || typeof vehicle.model !== 'string' || !vehicle.model.trim()) {
      return res.status(400).json({
        error: 'POST a vehicle object with a non-empty model field.',
      });
    }

    try { validateVehicle(vehicle); }
    catch (error) { return res.status(400).json({ error: error.message }); }

    const result = await enqueueAI(async () => {
      return new AgenticLoop({
        onProgress: (event) => console.error(`[research] ${JSON.stringify(event)}`),
      }).loop(vehicle);
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, () => console.log(`✅ Running on http://localhost:${PORT}`));
