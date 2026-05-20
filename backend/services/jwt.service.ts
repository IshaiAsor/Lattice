import * as jwt from 'jsonwebtoken';
import config from '../config/env.config';

export enum JwtPurpose {
    app_usage,
    app_usage_refresh,
    device_provisioning,
    device_usage,
    device_usage_refresh,
    google_cloud_to_cloud_login,
    google_cloud_to_cloud_login_refresh
}

class JwtService {
    generateToken(payload: any, purpose: JwtPurpose) {

        let tokenExp;

        switch (purpose) {
            case JwtPurpose.app_usage:
                {
                    tokenExp = config.Jwt.AppUsageExpiresIn;
                    break;
                }
                case JwtPurpose.app_usage_refresh:
                {
                    tokenExp = config.Jwt.AppUsageRefreshExpiresIn;
                    break;
                }
                case JwtPurpose.device_provisioning:
                {
                    tokenExp = config.Jwt.deviceProvisioningExpiresIn;
                    break;
                }
                case JwtPurpose.device_usage:
                {
                    tokenExp = config.Jwt.deviceExpiresIn;
                    break;
                }
                case JwtPurpose.device_usage_refresh:
                {
                    tokenExp = config.Jwt.deviceRefreshExpiresIn;
                    break;
                }
            case JwtPurpose.google_cloud_to_cloud_login:
                {
                    tokenExp = config.Jwt.GoogleCloudToCloudLoginExpiresIn;
                    break;
                }
            case JwtPurpose.google_cloud_to_cloud_login_refresh:
                {
                    tokenExp = config.Jwt.GoogleCloudToCloudLoginRefreshExpiresIn;
                    break;
                }
            default:
                throw new Error('Invalid token purpose');
        };

        console.log(`Jwt token will expire in: ${tokenExp} seconds`);

        return jwt.sign(
            {
                ...payload,
                purpose
            },
            config.Jwt.Secret,
            { expiresIn: tokenExp }
        );
    }

    verifyToken(token: string, purpose: JwtPurpose): { valid: boolean , decoded:any,err?:string|null} {
        try {
            let decoded = jwt.verify(token, config.Jwt.Secret) as any;
            if (decoded.purpose !== purpose) {
                console.log(`Invalid token purpose ${decoded.purpose}`);
                return { valid: false, decoded:null,err:`Invalid token purpose ${decoded.purpose}`};
            }
            return {valid:true,decoded:decoded};

        } catch (err) {
            console.log(`Jwt validation failed ${err}`);
            return { valid: false, decoded:null};
        }
    }

}
export const jwtService = new JwtService();
