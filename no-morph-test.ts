interface UserData {
  id: string;
  name: string;
}

function processUser(user: UserData) {
  return user.name;
}