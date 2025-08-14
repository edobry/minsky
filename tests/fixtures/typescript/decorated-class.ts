export class Repo {
  find(): any[] {
    return [];
  }
}

import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  email: string;

  @Column()
  name: string;

  constructor(email: string, name: string) {
    this.email = email;
    this.name = name;
  }
}
