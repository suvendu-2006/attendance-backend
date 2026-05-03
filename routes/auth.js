const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const DEVICE_COOKIE_NAME = 'device_token';

// Helper to set HTTP-only cookie
const setDeviceCookie = (res, token) => {
  res.cookie(DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 365 * 24 * 60 * 60 * 1000 // 1 year
  });
};

// 1. Student Login & Automatic Device Registration
router.post('/student/login', async (req, res) => {
  try {
    const { roll_number, password } = req.body;
    
    // In production, compare password hashes. Using plain match for placeholder.
    const { data: student, error } = await supabase
      .from('students')
      .select('*')
      .eq('roll_number', roll_number)
      .single();

    if (error || !student || student.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check device identity
    const providedCookie = req.cookies[DEVICE_COOKIE_NAME];
    
    const { data: device } = await supabase
      .from('devices')
      .select('*')
      .eq('student_id', student.id)
      .single();

    if (!device) {
      // First login - register device automatically
      const newToken = crypto.randomBytes(32).toString('hex');
      await supabase.from('devices').insert({
        student_id: student.id,
        cookie_token: newToken,
        last_reset_at: new Date().toISOString()
      });
      setDeviceCookie(res, newToken);
    } else {
      // Existing device - compare cookie
      if (!providedCookie || providedCookie !== device.cookie_token) {
        return res.status(403).json({ 
          error: 'DEVICE_MISMATCH', 
          message: 'You are attempting to log in from an unregistered device or cleared your cookies. Please register this new device.' 
        });
      }
    }

    // Issue Session Token
    const authToken = jwt.sign({ id: student.id, role: 'student' }, JWT_SECRET, { expiresIn: '30d' });

    res.json({ message: 'Login successful', token: authToken, student: { id: student.id, name: student.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Register New Device (Change Phone)
router.post('/student/register-device', async (req, res) => {
  try {
    const { roll_number, password } = req.body;
    
    const { data: student } = await supabase.from('students').select('*').eq('roll_number', roll_number).single();
    if (!student || student.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const { data: device } = await supabase.from('devices').select('*').eq('student_id', student.id).single();
    
    // Check 30-day cooldown
    if (device && device.last_reset_at) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const lastReset = new Date(device.last_reset_at);
      
      if (lastReset > thirtyDaysAgo) {
        return res.status(403).json({ error: 'COOLDOWN_ACTIVE', message: 'You can only change your device once every 30 days. Please ask your teacher to reset your limit.' });
      }
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    
    if (device) {
      await supabase.from('devices').update({
        cookie_token: newToken,
        last_reset_at: new Date().toISOString()
      }).eq('id', device.id);
    } else {
      await supabase.from('devices').insert({
        student_id: student.id,
        cookie_token: newToken,
        last_reset_at: new Date().toISOString()
      });
    }

    setDeviceCookie(res, newToken);
    res.json({ message: 'New device registered successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Teacher Login
router.post('/teacher/login', async (req, res) => {
  try {
    const { phone_number, password } = req.body;
    
    const { data: teacher, error } = await supabase
      .from('teachers')
      .select('*')
      .eq('phone_number', phone_number)
      .single();

    if (error || !teacher || teacher.password_hash !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const authToken = jwt.sign({ id: teacher.id, role: 'teacher' }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ message: 'Login successful', token: authToken, teacher: { id: teacher.id, name: teacher.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Teacher Resets Device Limit for a Student
router.post('/teacher/reset-device-limit', async (req, res) => {
  try {
    const { student_id } = req.body;
    // Note: In production, verify teacher JWT middleware here

    await supabase
      .from('devices')
      .update({ last_reset_at: null })
      .eq('student_id', student_id);

    res.json({ message: 'Device limit reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
