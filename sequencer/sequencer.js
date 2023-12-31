import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';
import { ethers, JsonRpcProvider } from 'ethers';

const app = express();
import {
  hashKeccak256,
  hashSHA256,
  hexToBuffer,
  logL1,
  logSeq,
  signDataECDSA,
  signDataRSA,
  stringify,
  verifySignatureECDSA,
} from '../commons/utils.js';
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());

let encTxBlock = [];
let encTxHashes = [];
let txBlock = [];

dotenv.config({ path: '../.env' });

const [privateKeyRSA, privateKeyECDSA, _, l2PublicKeyECDSA, gylmanPK, apiKey] =
  [
    process.env.SEQUENCER_PRIVATE_KEY_RSA,
    process.env.SEQUENCER_PRIVATE_KEY_ECDSA,
    process.env.SEQUENCER_PUBLIC_KEY_ECDSA,
    process.env.L2_PUBLIC_KEY_ECDSA,
    process.env.GYLMAN_PRIVATE_KEY,
    process.env.INFURA_API_KEY,
  ];

const provider = new JsonRpcProvider(
  `https://rpc-mumbai.maticvigil.com/v1/${apiKey}`
);

const wallet = new ethers.Wallet(gylmanPK, provider);

const contractAddress = '0xD8a6B2e81Cba914780e8E66dF2D4Fa189CD2974E';
const contractABI = [
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '_unlockTime',
        type: 'uint256',
      },
    ],
    stateMutability: 'payable',
    type: 'constructor',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: 'uint256',
        name: 'amount',
        type: 'uint256',
      },
      {
        indexed: false,
        internalType: 'uint256',
        name: 'when',
        type: 'uint256',
      },
    ],
    name: 'Withdrawal',
    type: 'event',
  },
  {
    inputs: [
      {
        internalType: 'bytes32[]',
        name: '_txHashes',
        type: 'bytes32[]',
      },
    ],
    name: 'addTxHashes',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [],
    name: 'owner',
    outputs: [
      {
        internalType: 'address payable',
        name: '',
        type: 'address',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    name: 'roundTxHashes',
    outputs: [
      {
        internalType: 'bytes32',
        name: '',
        type: 'bytes32',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'unlockTime',
    outputs: [
      {
        internalType: 'uint256',
        name: '',
        type: 'uint256',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const contract = new ethers.Contract(contractAddress, contractABI, wallet);

async function submitToL1(encTxHashes) {
  const tx = await contract.addTxHashes(encTxHashes);
  await tx.wait();
  logL1('transaction completed:', tx.hash);
}

function solvePuzzle(seed, iters) {
  let key = seed;
  for (let i = 0; i < iters; i++) {
    key = crypto.createHash('sha256').update(key).digest('hex');
  }
  return key;
}

async function decryptText(encryptedHex, ivHex, keyHex) {
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const key = Buffer.from(keyHex, 'hex');

  // Extract the auth tag (last 16 bytes)
  const authTag = encrypted.slice(encrypted.length - 16);
  const encryptedData = encrypted.slice(0, encrypted.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

async function consumeTx(req, res) {
  // Destructure the request body
  const { encTxHexStr, ivHexStr, unsolved } = req.body;
  logSeq('the received encTxHexStr:', encTxHexStr);
  logSeq('the received puzzle:', unsolved);
  // The code below is for ECDSA signing of encTxHexStrHash, since it has a problem on the user side,
  // we will do the offchain verification with RSA
  /*   
  // Hash the encrypted transaction as hex string, since we are planning to store only encrypted txs in the L1
  const encTxHexStrHash = hashKeccak256(encTxHexStr);
  // Push the hash of the encrypted transaction as hex string to block
  encTxHashes.push(encTxHexStrHash);
  // Since the method is FCFS, and we order starting from 0, the order is length of the block - 1
  const order = encTxHashes.length - 1;
  // Sign the hash of the encrypted transaction as hex string
  const signature = signDataECDSA(encTxHexStrHash, privateKeyECDSA); 
  */
  // Hash the encrypted transaction as hex string, since we are planning to store only encrypted txs in the L1
  const encTxHexStrHash = hashSHA256(encTxHexStr);
  // Push the hash of the encrypted transaction as hex string to block
  encTxHashes.push(encTxHexStrHash);
  // Since the method is FCFS, and we order starting from 0, the order is length of the block - 1
  const order = encTxHashes.length - 1;
  // Sign the hash of the encrypted transaction as hex string
  const signature = signDataRSA(encTxHexStrHash, privateKeyRSA);
  // Respond to the user
  res.status(200).json({
    encTxHexStrHash,
    order,
    signature,
  });
  // Solve the time-lock puzzle
  const decryptionKey = solvePuzzle(unsolved.seed, unsolved.iters);
  logSeq('the decryption key:', decryptionKey);
  // Decrypt the encrypted transaction using the key obtained from time-lock puzzle
  const tx = await decryptText(encTxHexStr, ivHexStr, decryptionKey);
  logSeq('the decrypted transaction:', tx);
  // Push the encrypted transaction as hex string, iv as string, and decryption key as hex string into the block of encrypted txs
  encTxBlock.push({ encTxHexStr, ivHexStr, decryptionKey });
  // Push the decrypted transactions into the transaction block
  txBlock.push(tx);
}

app.post('/order', consumeTx);

app.get('/block', async (req, res) => {
  // Default response
  let responseData = {
    encTxBlock: undefined,
    encTxBlockHash: undefined,
    signature: undefined,
  };
  logSeq('L2 is requesting block');
  // Send post request with encrypted tx hashes to get the signature of the L2
  try {
    const response = await axios.post(
      'http://localhost:4444/l2Signature',
      encTxHashes
    );
    const l2Signature = response.data.signature;
    // Stringify the encrypted tx hash list and hash it for signature verification
    const encTxHashesHash = hashKeccak256(stringify(encTxHashes));
    // Verify the signature
    const isValid = verifySignatureECDSA(
      encTxHashesHash,
      l2Signature,
      l2PublicKeyECDSA
    );
    logSeq("is L2's signature valid?", isValid);
    if (isValid) {
      // Ethers js requires that hashes must be prefixed with 0x, otherwise it throws an error
      encTxHashes = encTxHashes.map((encTxHash) => '0x' + encTxHash);
      // If the signature is valid, store the hash list in L1
      // submitToL1(encTxHashes);
      // Sign the hash of the encrypted transaction block
      const txBlockEncTxBlock = { encTxBlock, txBlock };
      const txBlockEncTxBlockHash = hashKeccak256(stringify(txBlockEncTxBlock));
      const signature = signDataECDSA(txBlockEncTxBlockHash, privateKeyECDSA);
      responseData = {
        txBlockEncTxBlock,
        signature,
      };
      encTxBlock = [];
      encTxHashes = [];
      txBlock = [];
    }
  } catch (error) {
    console.error("error requesting L2's signature:", error);
  }
  // Respond to L2 with the encrypted transaction block, and signature
  res.status(200).json(responseData);
});

app.listen(PORT, () => {
  logSeq('is running on port: ', PORT);
});
