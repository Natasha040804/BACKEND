const express = require('express');
const router = express.Router();
const db = require('../Config/db_connection');
const { authenticate } = require('../middleware/authmiddleware');

const buildConversationKey = (a, b) => {
  const first = Number(a);
  const second = Number(b);
  if (Number.isNaN(first) || Number.isNaN(second)) {
    throw new Error('Invalid participant ids');
  }
  return first < second ? `${first}-${second}` : `${second}-${first}`;
};

const ensureMessageSchema = async () => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS tbl_messages (
      message_id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_key VARCHAR(191) NOT NULL,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      message_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      read_at TIMESTAMP NULL DEFAULT NULL,
      INDEX idx_conversation_key (conversation_key),
      INDEX idx_receiver_unread (receiver_id, read_at),
      CONSTRAINT fk_sender_account FOREIGN KEY (sender_id) REFERENCES tbl_accounts(Account_id) ON DELETE CASCADE,
      CONSTRAINT fk_receiver_account FOREIGN KEY (receiver_id) REFERENCES tbl_accounts(Account_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await db.execute(createSql);
    console.log('✅ tbl_messages ready');
  } catch (error) {
    console.error('❌ Failed to ensure tbl_messages:', error?.message || error);
  }
};

ensureMessageSchema();

const mapAccountRow = (row) => ({
  accountId: row?.Account_id || row?.accountId,
  fullName: row?.Fullname || row?.fullName || row?.Username || null,
  username: row?.Username || null,
  email: row?.Email || null,
  role: row?.Role || null,
  contact: row?.Contact || null,
  branchId: row?.BranchID || null,
  branchName: row?.BranchName || row?.branchName || null,
  branchCode: row?.BranchCode || row?.branchCode || null,
});

router.get('/messages/recipients', authenticate, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const [rows] = await db.execute(
      `SELECT a.Account_id, a.Fullname, a.Username, a.Email, a.Role, a.Contact, a.BranchID,
              b.BranchName, b.BranchCode
       FROM tbl_accounts a
       LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
       WHERE Account_id <> ?
       ORDER BY Fullname ASC`,
      [userId]
    );

    res.json(rows.map(mapAccountRow));
  } catch (error) {
    console.error('Error loading message recipients:', error);
    res.status(500).json({ error: 'Failed to load recipients' });
  }
});

router.get('/messages/conversations', authenticate, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const [rows] = await db.execute(
      `SELECT
         sub.conversation_key,
         sub.other_user_id,
         sub.last_message,
         sub.last_message_at,
         sub.unread_count,
         acct.Fullname AS other_fullname,
         acct.Username AS other_username,
         acct.Email AS other_email,
         acct.Role AS other_role,
         acct.Contact AS other_contact,
         acct.BranchID AS other_branch,
        branches.BranchName AS other_branch_name,
        branches.BranchCode AS other_branch_code
       FROM (
         SELECT
           conversation_key,
           MAX(CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END) AS other_user_id,
           MAX(created_at) AS last_message_at,
           SUM(CASE WHEN receiver_id = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread_count,
           SUBSTRING_INDEX(
             GROUP_CONCAT(message_text ORDER BY created_at DESC SEPARATOR '||'),
             '||',
             1
           ) AS last_message
         FROM tbl_messages
         WHERE sender_id = ? OR receiver_id = ?
         GROUP BY conversation_key
       ) sub
       LEFT JOIN tbl_accounts acct ON acct.Account_id = sub.other_user_id
       LEFT JOIN tbl_branches branches ON branches.BranchID = acct.BranchID
       ORDER BY sub.last_message_at DESC`,
      [userId, userId, userId, userId]
    );

    const payload = rows.map((row) => ({
      conversationKey: row.conversation_key,
      participant: {
        accountId: row.other_user_id,
        fullName: row.other_fullname || row.other_username || 'Unknown User',
        username: row.other_username || null,
        email: row.other_email || null,
        role: row.other_role || null,
        contact: row.other_contact || null,
        branchId: row.other_branch || null,
        branchName: row.other_branch_name || null,
        branchCode: row.other_branch_code || null,
      },
      lastMessage: row.last_message || '',
      lastMessageAt: row.last_message_at,
      unreadCount: Number(row.unread_count) || 0,
    }));

    res.json(payload);
  } catch (error) {
    console.error('Error loading conversations:', error);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/messages/conversations/:conversationKey', authenticate, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const conversationKey = req.params.conversationKey;
    if (!/^\d+-\d+$/.test(conversationKey)) {
      return res.status(400).json({ error: 'Invalid conversation key' });
    }

    const [aStr, bStr] = conversationKey.split('-');
    const a = Number(aStr);
    const b = Number(bStr);
    const otherId = a === userId ? b : b === userId ? a : null;
    if (!otherId) {
      return res.status(403).json({ error: 'Not allowed to view this conversation' });
    }

    const [participantRows] = await db.execute(
      `SELECT a.Account_id, a.Fullname, a.Username, a.Email, a.Role, a.Contact, a.BranchID,
              b.BranchName, b.BranchCode
       FROM tbl_accounts a
       LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
       WHERE Account_id = ?
       LIMIT 1`,
      [otherId]
    );
    const participant = participantRows.length ? mapAccountRow(participantRows[0]) : null;

    const [rows] = await db.execute(
      `SELECT m.message_id, m.conversation_key, m.sender_id, m.receiver_id, m.message_text, m.created_at, m.read_at,
              sender.Fullname AS sender_name
       FROM tbl_messages m
       LEFT JOIN tbl_accounts sender ON sender.Account_id = m.sender_id
       WHERE m.conversation_key = ?
         AND (m.sender_id = ? OR m.receiver_id = ?)
       ORDER BY m.created_at ASC`,
      [conversationKey, userId, userId]
    );

    if (rows.length) {
      await db.execute(
        `UPDATE tbl_messages
         SET read_at = NOW()
         WHERE conversation_key = ? AND receiver_id = ? AND read_at IS NULL`,
        [conversationKey, userId]
      );
    }

    const messages = rows.map((row) => ({
      messageId: row.message_id,
      conversationKey: row.conversation_key,
      senderId: row.sender_id,
      receiverId: row.receiver_id,
      text: row.message_text,
      createdAt: row.created_at,
      readAt: row.read_at,
      senderName: row.sender_name || null,
    }));

    res.json({ conversationKey, participant, messages });
  } catch (error) {
    console.error('Error loading messages:', error);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

router.post('/messages/send', authenticate, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { recipientId, message } = req.body || {};
    if (!recipientId) {
      return res.status(400).json({ error: 'recipientId is required' });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message text is required' });
    }
    if (Number(recipientId) === Number(userId)) {
      return res.status(400).json({ error: 'Cannot send a message to yourself' });
    }

    const [recipientRows] = await db.execute(
      `SELECT a.Account_id, a.Fullname, a.Username, a.Email, a.Role, a.Contact, a.BranchID,
              b.BranchName, b.BranchCode
       FROM tbl_accounts a
       LEFT JOIN tbl_branches b ON b.BranchID = a.BranchID
       WHERE Account_id = ?
       LIMIT 1`,
      [recipientId]
    );
    if (!recipientRows.length) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const conversationKey = buildConversationKey(userId, recipientId);

    const [result] = await db.execute(
      `INSERT INTO tbl_messages (conversation_key, sender_id, receiver_id, message_text)
       VALUES (?, ?, ?, ?)`,
      [conversationKey, userId, recipientId, String(message).trim()]
    );

    const [messageRows] = await db.execute(
      `SELECT m.message_id, m.conversation_key, m.sender_id, m.receiver_id, m.message_text, m.created_at, m.read_at,
              sender.Fullname AS sender_name
       FROM tbl_messages m
       LEFT JOIN tbl_accounts sender ON sender.Account_id = m.sender_id
       WHERE m.message_id = ?
       LIMIT 1`,
      [result.insertId]
    );

    const savedMessage = messageRows.length
      ? {
          messageId: messageRows[0].message_id,
          conversationKey: messageRows[0].conversation_key,
          senderId: messageRows[0].sender_id,
          receiverId: messageRows[0].receiver_id,
          text: messageRows[0].message_text,
          createdAt: messageRows[0].created_at,
          readAt: messageRows[0].read_at,
          senderName: messageRows[0].sender_name || null,
        }
      : null;

    res.json({
      success: true,
      conversationKey,
      participant: mapAccountRow(recipientRows[0]),
      message: savedMessage,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
