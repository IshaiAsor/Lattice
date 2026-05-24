import config from '../config/env.config';
import { JwtPurpose, jwtService } from './jwt.service';
import { deviceMgmtService } from './device.mgmt.service';

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
    );
  }

  private async GenerateDevicePermenantMqttToken(userId: number, deviceId: number) {
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

    let refreshTokenCallbackUrl = `${config.baseUrl}/api/provisioning/refresh-token`; // Endpoint for clients to call to refresh their MQTT token
    return {
      deviceId: deviceId,
      mqttToken: token,
      refreshToken: refreshToken,
      refreshTokenCallbackUrl,
      validateCACert: config.mqtt.validateCert,
    };
  }

  async registerDevice(
    userId: number,
    provisioningToken: string,
    deviceType: string,
    deviceId: number,
    macAddress: string,
    version: string
  ) {
    console.log(`Received device registration request , 
      provisioningToken: ${provisioningToken}, deviceType: ${deviceType}, deviceId: ${deviceId}, macAddress: ${macAddress}, version: ${version}`);
    if (!provisioningToken || !deviceType || !macAddress || !deviceId || !version) {
      throw new Error('Missing required fields');
    }

    let newDevice = await deviceMgmtService.registerUserDevice(userId, provisioningToken, deviceType, deviceId, macAddress, version);

    var permanentToken = await this.GenerateDevicePermenantMqttToken(userId, newDevice.id);
    console.log(
      `Provisioning successful for device ${newDevice.id} of type ${deviceType} with MQTT token:`,
      permanentToken,
    );
    return permanentToken;
  }
}
export const provisioningService = new ProvisioningService();
