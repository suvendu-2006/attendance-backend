const express = require('express');
const crypto = require('crypto');
const supabase = require('../supabase');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';
const DEVICE_COOKIE_NAME = 'device_token';

// Helper to calculate distance in meters (Haversine)
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radius of the earth in m
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
  return R * c; // Distance in m
}

router.post('/check-in', async (req, res) => {
  const { session_id, nonce, timestamp, sig, gps_lat, gps_lng, student_id } = req.body;
  const ipAddress = req.ip || req.headers['x-forwarded-for'];
  let cookieMatchResult = false;
  
  // Log failure helper
  const logFlag = async (reasonCode) => {
    await supabase.from('flags').insert({
      student_id, session_id, reason_code: reasonCode, gps_lat, gps_lng, cookie_match_result: cookieMatchResult, ip_address: ipAddress
    });
  };

  try {
    // 1. Basic formatting
    if (!session_id || !nonce || !timestamp || !sig || !student_id || gps_lat === undefined) {
      return res.status(400).json({ error: 'Missing required payload parameters' });
    }

    const { data: student } = await supabase.from('students').select('*').eq('id', student_id).single();
    if (!student || !student.is_active) {
      await logFlag('STUDENT_INVALID');
      return res.status(401).json({ error: 'Invalid or inactive student ID' });
    }

    // 2. Device Cookie
    const providedCookie = req.cookies[DEVICE_COOKIE_NAME];
    const { data: device } = await supabase.from('devices').select('*').eq('student_id', student_id).single();
    
    if (!device || !providedCookie || providedCookie !== device.cookie_token) {
      cookieMatchResult = false;
      await logFlag('DEVICE_MISMATCH');
      return res.status(403).json({ error: 'DEVICE_MISMATCH', message: 'You must use your registered device.' });
    }
    cookieMatchResult = true; // Passed

    // 3. Duplicate Submission
    const { data: existingLog } = await supabase.from('attendance_logs').select('*').eq('student_id', student_id).eq('session_id', session_id).single();
    if (existingLog) {
      // Silently reject
      return res.json({ message: 'Attendance already recorded.' });
    }

    // 4. Session Window Check
    const { data: session } = await supabase.from('sessions').select('*').eq('id', session_id).single();
    if (!session || session.status !== 'ACTIVE' || new Date() > new Date(session.expires_at)) {
      await logFlag('WINDOW_CLOSED');
      return res.status(403).json({ error: 'WINDOW_CLOSED', message: 'The attendance window has closed.' });
    }

    // 5. Payload Signature
    const payloadString = `${session_id}:${nonce}:${timestamp}`;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payloadString).digest('hex');
    if (expectedSig !== sig) {
      await logFlag('SIGNATURE_INVALID');
      return res.status(403).json({ error: 'SIGNATURE_INVALID', message: 'Invalid check-in link.' });
    }

    // 6. Nonce Check (Entropy only, replay blocked by window & dup check)
    const { data: nonceRecord } = await supabase.from('nonces').select('*').eq('session_id', session_id).eq('nonce_value', nonce).single();
    if (!nonceRecord) {
      await logFlag('NONCE_INVALID');
      return res.status(403).json({ error: 'NONCE_INVALID', message: 'Invalid link.' });
    }

    // 7. GPS Boundary
    // MOCK CAMPUS COORDINATES - Load from ENV
    const CAMPUS_LAT = process.env.CAMPUS_LAT || 0;
    const CAMPUS_LNG = process.env.CAMPUS_LNG || 0;
    const RADIUS_M = 300;
    
    // Bypass GPS check in development if dummy coords used
    if (CAMPUS_LAT !== 0) {
      const distance = getDistanceFromLatLonInM(gps_lat, gps_lng, CAMPUS_LAT, CAMPUS_LNG);
      if (distance > RADIUS_M) {
        await logFlag('GPS_FAIL');
        return res.status(403).json({ error: 'GPS_FAIL', message: 'You must be on campus to mark attendance.' });
      }
    }

    // 8. VPN Check (ipapi logic to be implemented, mock pass for now)
    // await logFlag('VPN_DETECTED'); return res.status(403)...

    // ALL CHECKS PASSED -> Record Present
    await supabase.from('attendance_logs').insert({
      student_id,
      session_id,
      status: 'PRESENT',
      gps_lat,
      gps_lng,
      verification_method: 'DEEP_LINK'
    });

    // Notify Teacher Dashboard
    if (req.io) {
      req.io.to(`teacher_${session.teacher_id}`).emit('attendance_recorded', { student_id, name: student.name });
    }

    res.json({ message: 'Attendance marked successfully', status: 'PRESENT' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error processing attendance' });
  }
});

module.exports = router;
