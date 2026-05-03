const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabase');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

// Cache the demo teacher's real UUID after first creation
let demoTeacherId = null;

// Middleware to check if user is a teacher
// In production, extract token from Authorization header and verify JWT.
const requireTeacher = async (req, res, next) => {
  try {
    if (demoTeacherId) {
      req.teacher = { id: demoTeacherId };
      return next();
    }

    // Check if demo teacher already exists
    const { data: existing } = await supabase
      .from('teachers')
      .select('id')
      .eq('phone_number', 'demo-teacher')
      .single();

    if (existing) {
      demoTeacherId = existing.id;
      req.teacher = { id: demoTeacherId };
      return next();
    }

    // Create demo teacher on first use
    const { data: newTeacher, error } = await supabase
      .from('teachers')
      .insert({ name: 'Demo Teacher', phone_number: 'demo-teacher', password_hash: 'demo' })
      .select()
      .single();

    if (error) throw error;
    demoTeacherId = newTeacher.id;
    req.teacher = { id: demoTeacherId };
    next();
  } catch (err) {
    res.status(500).json({ error: 'Teacher auth failed: ' + err.message });
  }
};

// 1. Start Attendance Session
router.post('/start', requireTeacher, async (req, res) => {
  try {
    const teacherId = req.teacher.id;

    // A. Create Session
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .insert({
        teacher_id: teacherId,
        status: 'ACTIVE',
        started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 1000).toISOString() // 90 seconds
      })
      .select()
      .single();

    if (sessionError) throw sessionError;

    // B. Generate 1 shared nonce (Option A Group Link approach)
    const nonceValue = crypto.randomBytes(16).toString('hex');
    const { data: nonce, error: nonceError } = await supabase
      .from('nonces')
      .insert({
        session_id: session.id,
        nonce_value: nonceValue
      })
      .select()
      .single();

    if (nonceError) throw nonceError;

    // C. Generate Signed Deep Link
    const timestamp = Date.now().toString();
    const payloadString = `${session.id}:${nonceValue}:${timestamp}`;
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(payloadString).digest('hex');
    
    // In production this would be your actual domain
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const deepLinkUrl = `${baseUrl}/check-in?session_id=${session.id}&nonce=${nonceValue}&t=${timestamp}&sig=${signature}`;

    // Emit event to Teacher dashboard
    if (req.io) {
      req.io.to(`teacher_${teacherId}`).emit('session_started', { session, deepLinkUrl });
    }

    res.json({ message: 'Session started successfully', session, deepLinkUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Extend Session Window
router.post('/extend', requireTeacher, async (req, res) => {
  try {
    const { session_id } = req.body;
    
    // Look up session
    const { data: session } = await supabase.from('sessions').select('*').eq('id', session_id).single();
    if (!session || session.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Session not active' });
    }

    // Add 30 seconds
    const newExpiresAt = new Date(new Date(session.expires_at).getTime() + 30 * 1000).toISOString();
    
    await supabase.from('sessions').update({ expires_at: newExpiresAt }).eq('id', session_id);
    
    if (req.io) {
      req.io.to(`teacher_${req.teacher.id}`).emit('session_extended', { newExpiresAt });
    }

    res.json({ message: 'Session extended by 30 seconds', newExpiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
