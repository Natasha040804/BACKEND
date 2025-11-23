const express = require('express');
const router = express.Router();
const gpsTracker = require('../utils/gpsTracker');

// Get delivery tracking status
router.get('/:deliveryId', async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const status = gpsTracker.getDeliveryStatus(deliveryId);

    if (!status) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found or not being tracked',
      });
    }

    res.json({ success: true, data: status });
  } catch (error) {
    console.error('Error getting delivery status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update delivery location (for mobile app)
router.post('/:deliveryId/location', async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const { latitude, longitude, status } = req.body || {};

    let ok = gpsTracker.updateLocation(
      deliveryId,
      { lat: Number(latitude), lng: Number(longitude) },
      status
    );

    // If not currently tracked, auto-start tracking with this first location
    if (!ok && (latitude != null && longitude != null)) {
      gpsTracker.startTracking(deliveryId, { lat: Number(latitude), lng: Number(longitude) });
      ok = gpsTracker.updateLocation(
        deliveryId,
        { lat: Number(latitude), lng: Number(longitude) },
        status
      );
    }

    if (!ok) {
      return res.status(404).json({ success: false, message: 'Delivery not found or not tracked' });
    }

    res.json({ success: true, message: 'Location updated successfully' });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Mark delivery as picked up
router.post('/:deliveryId/pickup', async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const { dropoffLocation } = req.body || {};

    const ok = gpsTracker.markAsPickedUp(deliveryId, dropoffLocation);

    if (!ok) {
      return res.status(404).json({ success: false, message: 'Delivery not found or not tracked' });
    }

    res.json({ success: true, message: 'Delivery marked as picked up' });
  } catch (error) {
    console.error('Error marking as picked up:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Mark delivery as delivered
router.post('/:deliveryId/delivered', async (req, res) => {
  try {
    const { deliveryId } = req.params;

    const ok = gpsTracker.markAsDelivered(deliveryId);

    if (!ok) {
      return res.status(404).json({ success: false, message: 'Delivery not found or not tracked' });
    }

    res.json({ success: true, message: 'Delivery marked as delivered' });
  } catch (error) {
    console.error('Error marking as delivered:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
