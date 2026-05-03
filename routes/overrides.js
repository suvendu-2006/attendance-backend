const express = require('express');
const supabase = require('../supabase');

const router = express.Router();

const requireTeacher = (req, res, next) => {
  // Mock verification
  req.teacher = { id: 'teacher-uuid-placeholder' };
  next();
};

// 1. Student Requests Guest Mode
router.post('/guest-request', async (req, res) => {
  try {
    const { student_id, session_id } = req.body;
    
    // Insert pending request
    await supabase.from('guest_requests').insert({
      student_id,
      session_id,
      status: 'PENDING'
    });

    // Notify Teacher
    const { data: session } = await supabase.from('sessions').select('teacher_id').eq('id', session_id).single();
    if (session && req.io) {
      req.io.to(`teacher_${session.teacher_id}`).emit('guest_request_received', { student_id });
    }

    res.json({ message: 'Guest request sent to teacher.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Teacher Approves Guest Request
router.post('/approve-guest', requireTeacher, async (req, res) => {
  try {
    const { request_id, student_id, session_id } = req.body;
    
    await supabase.from('guest_requests').update({ status: 'APPROVED', approved_by: req.teacher.id }).eq('id', request_id);
    
    await supabase.from('attendance_logs').insert({
      student_id,
      session_id,
      status: 'PRESENT',
      verification_method: 'GUEST_MODE'
    });

    res.json({ message: 'Guest approved and attendance marked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 5-Minute Manual Override (Teacher marks student present post-class)
router.post('/manual-override', requireTeacher, async (req, res) => {
  try {
    const { student_id, session_id } = req.body;

    const { data: session } = await supabase.from('sessions').select('*').eq('id', session_id).single();
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Check if within 5 mins of expiry
    const fiveMinsAfterExpiry = new Date(new Date(session.expires_at).getTime() + 5 * 60 * 1000);
    if (new Date() > fiveMinsAfterExpiry) {
      return res.status(403).json({ error: 'Manual override window (5 mins) has closed.' });
    }

    await supabase.from('attendance_logs').insert({
      student_id,
      session_id,
      status: 'PRESENT',
      verification_method: 'MANUAL_OVERRIDE'
    });

    res.json({ message: 'Attendance manually overridden successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
