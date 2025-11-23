class GPSTracker {
  constructor() {
    // Map<deliveryId, { currentLocation, pickupLocation, dropoffLocation, status, history: Array<{location, timestamp, status}> }>
    this.activeDeliveries = new Map();
  }

  // Start tracking a delivery
  startTracking(deliveryId, initialLocation) {
    if (!deliveryId) return;
    const now = new Date();
    const initLoc = initialLocation || null;
    this.activeDeliveries.set(String(deliveryId), {
      currentLocation: initLoc,
      pickupLocation: initLoc,
      dropoffLocation: null,
      status: 'en_route_to_pickup',
      history: [
        {
          location: initLoc,
          timestamp: now,
          status: 'en_route_to_pickup',
        },
      ],
    });
  }

  // Update delivery location
  updateLocation(deliveryId, newLocation, status) {
    const key = String(deliveryId);
    const delivery = this.activeDeliveries.get(key);
    if (delivery) {
      delivery.currentLocation = newLocation;
      if (status) delivery.status = status;
      delivery.history.push({
        location: newLocation,
        timestamp: new Date(),
        status: status || delivery.status,
      });
      return true;
    }
    return false;
  }

  // Mark as picked up
  markAsPickedUp(deliveryId, dropoffLocation) {
    const key = String(deliveryId);
    const delivery = this.activeDeliveries.get(key);
    if (delivery) {
      delivery.status = 'en_route_to_dropoff';
      delivery.dropoffLocation = dropoffLocation || delivery.dropoffLocation || null;
      delivery.history.push({
        location: delivery.currentLocation,
        timestamp: new Date(),
        status: 'picked_up',
      });
      return true;
    }
    return false;
  }

  // Mark as delivered
  markAsDelivered(deliveryId) {
    const key = String(deliveryId);
    const delivery = this.activeDeliveries.get(key);
    if (delivery) {
      delivery.status = 'delivered';
      delivery.history.push({
        location: delivery.currentLocation,
        timestamp: new Date(),
        status: 'delivered',
      });
      return true;
    }
    return false;
  }

  // Get current delivery status
  getDeliveryStatus(deliveryId) {
    return this.activeDeliveries.get(String(deliveryId));
  }

  // Get all active deliveries as [id, payload]
  getActiveDeliveries() {
    return Array.from(this.activeDeliveries.entries());
  }
}

module.exports = new GPSTracker();
