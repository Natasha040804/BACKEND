const db = require('../Config/db_connection');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

exports.login = async (req,res)=> {
    // Accept either username or email for flexibility (mobile uses email)
    const { username, email, password } = req.body || {};
    const lookup = username || email;
    const isProd = process.env.NODE_ENV === 'production';

    // Basic input validation
    if (!lookup || !password) {
        return res.status(400).json({ error: 'Username/email and password required' });
    }

    // Verify JWT secrets exist to avoid silent 500
    const accessSecret = process.env.JWT_ACCESS_SECRET;
    const refreshSecret = process.env.JWT_REFRESH_SECRET;
    if (!accessSecret || !refreshSecret) {
        console.error('Auth configuration error: missing JWT secrets', {
            hasAccess: !!accessSecret,
            hasRefresh: !!refreshSecret
        });
        return res.status(500).json({ error: 'Auth configuration error' });
    }

    try {
        // Fetch user (username OR email)
        const [users] = await db.query(
            'SELECT * FROM tbl_accounts WHERE Username = ? OR Email = ? LIMIT 1',
            [lookup, lookup]
        );
        if (!users.length) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const user = users[0];

        // Password check
        let isPasswordValid = false;
        try {
            isPasswordValid = await bcrypt.compare(password, user.Password);
        } catch (e) {
            console.error('bcrypt compare failed:', e);
            return res.status(500).json({ error: isProd ? 'Server Error' : 'Password verification failed' });
        }
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        // Normalize role: map legacy 'ae' to 'AccountExecutive'
        const normalizedRole = (user.Role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : user.Role;

        // Token generation (10h access / 7d refresh)
        let accessToken, refreshToken;
        try {
            accessToken = jwt.sign(
                { userId: user.Account_id, role: normalizedRole },
                accessSecret,
                { expiresIn: '10h' }
            );
            refreshToken = jwt.sign(
                { userId: user.Account_id },
                refreshSecret,
                { expiresIn: '7d' }
            );
        } catch (e) {
            console.error('JWT sign failed:', e);
            return res.status(500).json({ error: isProd ? 'Server Error' : 'Token creation failed' });
        }

        // Persist refresh token
        try {
            await db.query('UPDATE tbl_accounts SET Refresh_Token = ? WHERE Account_id = ?', [refreshToken, user.Account_id]);
        } catch (e) {
            console.error('Refresh token DB update failed:', e);
            return res.status(500).json({ error: isProd ? 'Server Error' : 'Failed to persist refresh token' });
        }

        // Cookie options
        const baseCookieOpts = {
            httpOnly: true,
            secure: isProd,
            maxAge: 10 * 60 * 60 * 1000
        };
        const refreshCookieOpts = {
            httpOnly: true,
            secure: isProd,
            maxAge: 7 * 24 * 60 * 60 * 1000
        };
        if (isProd) {
            baseCookieOpts.sameSite = 'None';
            refreshCookieOpts.sameSite = 'None';
        } else {
            baseCookieOpts.sameSite = 'Lax';
            refreshCookieOpts.sameSite = 'Lax';
        }
        try {
            res.cookie('accessToken', accessToken, baseCookieOpts);
            res.cookie('refreshToken', refreshToken, refreshCookieOpts);
        } catch (e) {
            console.error('Setting cookies failed:', e);
            // Non-fatal; continue to return tokens in body
        }

        const userPayload = {
            id: user.Account_id,
            username: user.Username,
            fullname: user.Fullname,
            email: user.Email,
            role: normalizedRole,
            employeeId: user.EmployeeID,
            contact: user.Contact,
            address: user.Address,
            photo: user.Photo,
            branchId: user.BranchID
        };

        console.log('Login success', {
            user: user.Username || user.Email,
            id: user.Account_id,
            role: normalizedRole
        });

        return res.json({
            success: true,
            Role: normalizedRole,
            role: normalizedRole,
            accessTokenExpires: new Date(Date.now() + 10 * 60 * 60 * 1000),
            accessToken,
            refreshToken,
            user: userPayload
        });
    } catch (error) {
        console.error('Login Error (catch):', error && error.stack ? error.stack : error);
        const msg = isProd ? 'Server Error' : `Server Error: ${error.message || 'Unknown'}`;
        return res.status(500).json({ error: msg });
    }
};

exports.refreshToken = async (req, res) => {
    // Support token from cookie (web) or JSON body (mobile)
    const tokenFromCookie = req.cookies && req.cookies.refreshToken;
    const tokenFromBody = req.body && req.body.refreshToken;
    const refreshToken = tokenFromBody || tokenFromCookie;
    if (!refreshToken) return res.status(401).json({ error: "Unauthorized" });
    
    try {
        if (!process.env.JWT_REFRESH_SECRET || !process.env.JWT_ACCESS_SECRET) {
            console.error('Missing JWT secrets in refreshToken flow');
            return res.status(500).json({ error: 'Auth configuration error' });
        }
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const [users] = await db.query('SELECT * FROM tbl_accounts WHERE Account_id = ? AND  Refresh_Token = ?', [decoded.userId, refreshToken]
        );

        if (!users.length) {
            return res.status(401).json({ error: "Invalid refresh token"});
        }
        
        const user = users[0];
        const normalizedRole = (user.Role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : user.Role;
        const newAccessToken = jwt.sign(
            { userId: user.Account_id, role: normalizedRole },
            process.env.JWT_ACCESS_SECRET,
            { expiresIn: '10h' }
        );

    // Set cookie for web clients; mobile clients ignore it but use response body
    const isProd = process.env.NODE_ENV === 'production';
    const accessCookieOpts = {
        httpOnly: true,
        secure: isProd,
        maxAge: 10 * 60 * 60 * 1000, // 10 hours
        sameSite: isProd ? 'None' : 'Lax'
    };
    res.cookie('accessToken', newAccessToken, accessCookieOpts);
    res.json({ success: true, accessToken: newAccessToken });
    } catch (error) {
        console.error("Refresh Token Error:", error && error.stack ? error.stack : error);
        // Distinguish config vs invalid token in non-prod
        const isProd = process.env.NODE_ENV === 'production';
        const msg = /configuration/i.test(error.message) ? 'Auth configuration error' : 'Invalid refresh token';
        res.status(401).json({ error: isProd ? 'Invalid refresh token' : msg });
    }    
};

exports.logout = async(req, res) => {
    const userId = req.user?.userId;
    if(userId) {
    await db.query('UPDATE tbl_accounts SET Refresh_Token = NULL WHERE Account_id = ?', [userId]
        );
    }

    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    res.json({ success: true, message: "Logged out successfully" });
};

// Return the current authenticated user from token
exports.me = async (req, res) => {
    try {
        const userId = req.user?.userId;
        if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const [rows] = await db.query('SELECT Account_id as userID, Username as username, Role as role, Fullname as fullname, Email as email FROM tbl_accounts WHERE Account_id = ? LIMIT 1', [userId]);
        if (!rows || !rows.length) return res.status(404).json({ error: 'User not found' });
        const u = rows[0];
    // map role alias if needed and return both Role and role
    const normalizedRole = (u.role || '').toLowerCase() === 'ae' ? 'AccountExecutive' : u.role;
    res.json({ userID: u.userID, username: u.username, Role: normalizedRole, role: normalizedRole, fullname: u.fullname, email: u.email });
    } catch (e) {
        console.error('me error:', e);
        res.status(500).json({ error: 'Server Error' });
    }
};