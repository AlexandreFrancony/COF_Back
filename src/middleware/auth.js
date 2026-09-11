import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(403).json({ error: 'Invalid token' });
  }
}

export function requireGm(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'gm') {
    return res.status(403).json({ error: 'GM access required' });
  }

  next();
}

export function generateToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  };

  const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}
