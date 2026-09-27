export interface User extends UserBase {
  email: string;
  flags?: Array<'god' | 'staff' | 'banned'>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UserBase {
  _id?: string;
  displayName: string;
  username: string;
}
