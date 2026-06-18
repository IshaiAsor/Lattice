// GET /provision-token moved to services/device-gateway (provisioningRouter).
// The backend no longer owns any provisioning endpoints.
import express from 'express';
const router = express.Router();
export default router;
