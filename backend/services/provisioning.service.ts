import config from '../config/env.config';
import { JwtPurpose, jwtService } from './jwt.service';
import { deviceMgmtService } from './device.mgmt.service';
import { redisService } from './redis.service';
import { userDevicesRepository } from '../dal/user.devices.repository';
import * as crypto from 'crypto';

class ProvisioningService {
  async GenerateProvisioningToken(userId: number) {
    const tokenPayload = { userId };
    const token = jwtService.generateToken(tokenPayload, JwtPurpose.device_provisioning);
    console.log(`Generated provisioning token for user ${userId}: ${token}`);

    const provisioningCallbackUrl = `${config.baseUrl}/api/provisioning/register-device`;
    return {
      provisioningToken: token,
      userId: userId.toString(),
      server: config.mqtt.serverName,
      mqttPort: config.mqtt.port,
      provisioningCallbackUrl: provisioningCallbackUrl,
      validateCACert: config.mqtt.validateCert,
    };
  }

  RefreshMqttToken(refreshToken: string) {
    console.log(`Received refresh token: ${refreshToken}`);
    const verificationResult = jwtService.verifyToken(
      refreshToken,
      JwtPurpose.device_usage_refresh,
    );
    if (!verificationResult.valid) {
      throw new Error('Invalid or expired refresh token');
    }

    return this.GenerateDevicePermenantMqttToken(
      verificationResult.decoded.userId,
      verificationResult.decoded.deviceId,
      verificationResult.decoded.version,
    );
  }

  private async GenerateDevicePermenantMqttToken(
    userId: number,
    deviceId: number,
    deviceVersion: string,
  ) {
    const tokenPayload = {
      userid: userId,
      clientid: deviceId,
    };

    const token = jwtService.generateToken(tokenPayload, JwtPurpose.device_usage);

    let refreshTokenPayload = { userId, deviceId };
    const refreshToken = jwtService.generateToken(
      refreshTokenPayload,
      JwtPurpose.device_usage_refresh,
    );

    const refreshTokenCallbackUrl = `${config.baseUrl}/api/provisioning/refresh-token`;
    const deviceConfigUrl = `${config.baseUrl}/api/device/${encodeURIComponent(deviceVersion)}/configuration`;
    return {
      deviceId: deviceId,
      mqttToken: token,
      refreshToken: refreshToken,
      refreshTokenCallbackUrl,
      deviceConfigUrl,
      validateCACert: config.mqtt.validateCert,
      wsStreamUrl: config.baseUrl,
      cameraHttpUrl: config.baseUrl,
    };
  }

  private async GenerateDeviceTempMqttToken(userId: number, macAddress: string) {
    const tokenPayload = {
      userid: userId,
      clientid: macAddress, // Using MAC address as temporary clientid
    };

    const token = jwtService.generateToken(tokenPayload, JwtPurpose.device_temp_usage);

    return {
      mqttToken: token,
      validateCACert: config.mqtt.validateCert,
    };
  }

  async registerDevice(
    userId: number,
    provisioningToken: string,
    deviceType: string,
    deviceId: string,
    macAddress: string,
    version: string,
  ) {
    console.log(`Received device registration request (Step 1), 
      provisioningToken: ${provisioningToken}, deviceType: ${deviceType}, deviceId: ${deviceId}, macAddress: ${macAddress}, version: ${version}`);

    if (!provisioningToken || !deviceType || !macAddress || !deviceId || !version) {
      throw new Error('Missing required fields');
    }

    // 1. Validate uniqueness
    try {
      const existingDevice = await userDevicesRepository.getByMacId(macAddress);
      if (existingDevice) {
        throw new Error('Device already registered');
      }
    } catch (err: any) {
      if (err.message !== 'Device not found') {
        throw err;
      }
    }

    // 2. Save to Redis
    const registrationId = crypto.randomUUID();
    const registrationData = {
      userId,
      deviceType,
      deviceId,
      macAddress,
      version,
    };

    await redisService.connect();
    await redisService.setTempData(`reg:${registrationId}`, registrationData, 600); // 10 minutes TTL

    // 3. Generate temp MQTT token
    const tempToken = await this.GenerateDeviceTempMqttToken(userId, macAddress);

    console.log(`Registration (Step 1) successful for registrationId: ${registrationId}`);

    return {
      registrationId,
      ...tempToken,
      finalizeCallbackUrl: `${config.baseUrl}/api/provisioning/finalize-registration`,
    };
  }

  async finalizeRegistration(registrationId: string) {
    console.log(`Finalizing registration for registrationId: ${registrationId}`);

    await redisService.connect();
    const registrationData = await redisService.getTempData<any>(`reg:${registrationId}`);

    if (!registrationData) {
      throw new Error('Registration expired or invalid');
    }

    const { userId, deviceType, deviceId, macAddress, version } = registrationData;

    // 4. Call server and insert to db
    let newDevice = await deviceMgmtService.registerUserDevice(
      userId,
      '',
      deviceType,
      deviceId,
      macAddress,
      version,
    );

    // 5. Generate permanent token
    var permanentToken = await this.GenerateDevicePermenantMqttToken(userId, newDevice.id, version);

    // 6. Cleanup Redis
    await redisService.deleteTempData(`reg:${registrationId}`);

    console.log(
      `Finalization successful for device ${newDevice.id} of type ${deviceType}`,
      permanentToken,
    );
    return permanentToken;
  }
}
export const provisioningService = new ProvisioningService();
