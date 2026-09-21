export function formatUser(user) {
  return `${user.name} <${user.email}>`;
}

export function initials(name) {
  return name.split(/\s+/).filter(Boolean).map(part => part[0].toUpperCase()).join('');
}
