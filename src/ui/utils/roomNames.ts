const animals = [
  'Zebra',
  'Fox',
  'Otter',
  'Tiger',
  'Panda',
  'Falcon',
  'Dolphin',
  'Wolf',
  'Koi',
  'Tortoise',
  'Lynx',
  'Crane'
]

const objects = [
  'Tree',
  'River',
  'Mesa',
  'Lantern',
  'Comet',
  'Garden',
  'Canyon',
  'Harbor',
  'Summit',
  'Forge',
  'Meadow',
  'Temple'
]

function pick<T>(list: T[]): T {
  const value = list[Math.floor(Math.random() * list.length)]
  if (value === undefined) {
    throw new Error('Cannot pick from an empty list')
  }
  return value
}

export function generateRoomName(): string {
  const first = pick(animals)
  const second = pick(objects)
  const withNumber = Math.random() < 0.35
  const suffix = withNumber ? ` ${Math.floor(Math.random() * 9) + 1}` : ''
  return `${first} ${second}${suffix}`
}

export function toRoomSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
