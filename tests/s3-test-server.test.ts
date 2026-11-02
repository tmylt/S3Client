import { afterEach, expect, it } from 'vitest';
import { LocalS3, adaptCopySourceForFixture, encodeListingXML, fixZeroRangeForFixture } from './s3-test-server';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const servers: LocalS3[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

it('stores and lists S3 objects using a Node test server', async () => {
  const server = await LocalS3.start('fixture-bucket'); servers.push(server);
  await server.put('folder/100% + #.txt', Buffer.from('exact bytes'));
  expect(await server.keys('folder/')).toEqual(['folder/100% + #.txt']);
  expect(await server.bytes('folder/100% + #.txt')).toEqual(Buffer.from('exact bytes'));
});

it('encodes listing keys like S3 when EncodingType=url is requested', () => {
  const xml = '<ListBucketResult><Prefix>folder/</Prefix><Contents><Key>folder/100% + #.txt</Key></Contents></ListBucketResult>';
  expect(encodeListingXML(xml).toString()).toContain('<Key>folder/100%25%20%2B%20%23.txt</Key>');
  expect(encodeListingXML(xml, true).toString()).toContain('<Key>folder/100%25+%2B+%23.txt</Key>');
});

it('adapts encoded copy source headers to the fixture server decoder', () => {
  const source = 'fixture-bucket/folder/100%25%20%2B%20%23.txt';
  expect(decodeURI(adaptCopySourceForFixture(source))).toBe('fixture-bucket/folder/100% + #.txt');
});

it('corrects the fixture server zero-range response for video probes', async () => {
  const server = await LocalS3.start('range-bucket'); servers.push(server);
  await server.put('video.mp4', 'abcdef', 'video/mp4');
  const result = await server.client.send(new GetObjectCommand({ Bucket: server.bucket, Key: 'video.mp4', Range: 'bytes=0-0' }));
  expect(result.$metadata.httpStatusCode).toBe(206);
  const corrected = fixZeroRangeForFixture({ 'content-range': result.ContentRange, 'content-length': String(result.ContentLength) }, Buffer.from(await result.Body!.transformToByteArray()));
  expect(corrected.headers['content-range']).toBe('bytes 0-0/6');
  expect(corrected.headers['content-length']).toBe('1');
  expect(corrected.body).toEqual(Buffer.from('a'));
});

it('lists neighboring folders after an unrelated file is deleted', async () => {
  const server = await LocalS3.start('folders-bucket'); servers.push(server);
  await server.putAll([
    ['workspace/packaged-delete.txt', 'delete file'],
    ['workspace/packaged-trash/', ''],
    ['workspace/packaged-trash/nested/file.txt', 'delete nested file'],
    ['workspace/packaged-trash-neighbor/keep.txt', 'keep neighbor'],
  ]);
  const folderNames = async () => (await server.client.send(new ListObjectsV2Command({ Bucket: server.bucket, Prefix: 'workspace/', Delimiter: '/' }))).CommonPrefixes?.map(item => item.Prefix) ?? [];
  expect(await folderNames()).toEqual(['workspace/packaged-trash-neighbor/', 'workspace/packaged-trash/']);
  await server.delete('workspace/packaged-delete.txt');
  expect(await folderNames()).toContain('workspace/packaged-trash/');
});

it('paginates more than 1,000 fixture keys for recursive searches', async () => {
  const server = await LocalS3.start('paged-bucket'); servers.push(server);
  await server.putAll(Array.from({ length: 1005 }, (_, index) => [`workspace/paged/item${index}.txt`, 'x'] as const));
  await server.put('workspace/documents/nested/deep.txt', 'deep');
  const keys = await server.keys('workspace/');
  expect(keys).toHaveLength(1006);
  expect(keys).toContain('workspace/documents/nested/deep.txt');
});
