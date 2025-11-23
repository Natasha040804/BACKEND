const jwt = require('jsonwebtoken');
const db = require('../Config/db_connection');

exports.authenticate = async (req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
           // Dev trace: see if cookies or headers arrive
           const hasHdr = !!(req.headers['authorization'] || req.headers['Authorization']);
           const hasAcc = !!(req.cookies && req.cookies.accessToken);
           const hasRef = !!(req.cookies && req.cookies.refreshToken);
           console.log(`[AUTH] ${req.method} ${req.originalUrl} | hdr:${hasHdr} access:${hasAcc} refresh:${hasRef}`);
    }

    // 0. Support Authorization: Bearer header for mobile clients
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        try {
            const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
            // Normalize different token schemas: userId | userID | id | Account_Id
            const resolvedUserId = decoded.userId || decoded.userID || decoded.id || decoded.Account_Id || decoded.Account_id;
            const normalizedRole = (decoded.role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : decoded.role;
            if (resolvedUserId) {
                req.user = { userId: resolvedUserId, role: normalizedRole };
                if (process.env.NODE_ENV !== 'production') {
                    console.log(`[AUTH OK] via header | userId:${resolvedUserId} role:${normalizedRole}`);
                }
                return next();
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    console.warn('[AUTH WARN] Header token verified but missing userId. Decoded keys:', Object.keys(decoded));
                }
                // fall through to cookie/refresh verification instead of failing
            }
        } catch (err) {
            console.warn('[AUTH ERR] Bearer verify failed:', err && err.message);
            // continue to cookie/refresh flow
        }
    }

    const accessToken = req.cookies.accessToken;
    
    //1.check of access token first
    if(accessToken) {
        try {
            const decoded = jwt.verify(accessToken, process.env.JWT_ACCESS_SECRET);
            const resolvedUserId = decoded.userId || decoded.userID || decoded.id || decoded.Account_Id || decoded.Account_id;
            const normalizedRole = (decoded.role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : decoded.role;
            req.user = { userId: resolvedUserId, role: normalizedRole };
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[AUTH OK] via cookie accessToken | userId:${resolvedUserId} role:${normalizedRole}`);
            }
            return next();

        } catch (err) {
            if(err.name !== 'TokenExpiredError') {
                console.warn('[AUTH ERR] accessToken verify failed:', err && err.message);
                // continue to refresh flow
            }
        }
    }

    //2. if access token is not present, check for refresh token
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
        return res.status(401).json({ error: 'Please Login'});

    }
    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const [users] = await db.query('SELECT * FROM tbl_accounts WHERE Account_Id = ? AND Refresh_Token = ?', [decoded.userId, refreshToken]
        );

        if (!users.length) {
            return res.status(401).json({ error: 'Session Expired'});
        };
        //generate new token Access
        const user = users[0];
        const normalizedRole = (user.Role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : user.Role;
        const newAccessToken = jwt.sign(
            { userId: user.Account_Id, role: normalizedRole },
            process.env.JWT_ACCESS_SECRET,
            { expiresIn: '15m'}  
        );
        //Set new Cookie
        res.cookie('accessToken', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 15 * 60 * 1000
        });
    //attach user to request with normalized role
    req.user = { userId: user.Account_Id, role: normalizedRole };
        if (process.env.NODE_ENV !== 'production') {
            console.log(`[AUTH OK] via refresh | userId:${user.Account_Id} role:${normalizedRole}`);
        }
        next(); 
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(401).json({ error: 'Invalid Refresh Token' });
    }
};

exports.authorize = (roles) => {
    return (req, res, next) => {
        const userRole = (req.user && req.user.role || '').toLowerCase();
        const normalizedAllowed = (roles || []).map(r => (r || '').toLowerCase());
        if (!normalizedAllowed.includes(userRole)) {
            return res.status(401).json({ error: 'Forbidden' });
        }
        next();
    }
};