import { googleActionTypesRepository } from '../dal/google.action.types.repository';

export interface GoogleActionTypeView {
  id: number;
  name: string;
  value: string;
}

class GoogleActionsTypesService {
  async getGoogleActionTypes(): Promise<GoogleActionTypeView[]> {
    return await googleActionTypesRepository.getAll();
  }
}

export const googleActionsTypesService = new GoogleActionsTypesService();
